import { describe, expect, test } from "bun:test";
import { loadProfile, type ProductProfile } from "../core/profile";
import type { BinaryResolver } from "../tools/exec";
import {
  createSerialBackend,
  fakeSerialBackend,
  SerialCaptureSession,
} from "../tools/serialCapture";

const PROFILE_YAML = [
  "prodotto: DEMO-BOARD-01",
  "chip:",
  "  famiglia: stm32",
  "  regioni:",
  "    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 65536 }",
  "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 16384 }",
  'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP]",
  "criteri:",
  '  - seriale_contiene: "BOOT OK"',
  "tentativi_max: 3",
].join("\n");

const none: BinaryResolver = () => null;

function profileWithSerial(extra = ""): ProductProfile {
  const result = loadProfile(`${PROFILE_YAML}\n${extra}`);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
}

describe("serial capture session", () => {
  test("started before flash and reset, it captures the whole boot", async () => {
    const session = new SerialCaptureSession(fakeSerialBackend("BOOT OK\ncounter=1\n"));

    const started = session.start();
    expect(started.ok).toBe(true);
    session.noteFlash();
    session.noteReset();

    const result = await session.stop();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verification).toBe("SIMULATED");
      expect(result.value.complete).toBe(true);
      expect(result.value.reason).toBeNull();
      expect(result.value.missed).toEqual([]);
      expect(result.value.text).toContain("BOOT OK");
      expect(result.value.events.map((event) => event.kind)).toEqual(["flash", "reset"]);
    }
  });

  test("a capture started after the reset is flagged as incomplete", async () => {
    const session = new SerialCaptureSession(fakeSerialBackend("counter=2\n"));
    session.noteReset();
    session.start();

    const result = await session.stop();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complete).toBe(false);
      expect(result.value.missed.map((event) => event.kind)).toEqual(["reset"]);
      expect(result.value.reason).toContain("reset");
      expect(result.value.reason).toContain("missing");
      // The bytes are real, but they do not cover the boot.
      expect(result.value.text).toBe("counter=2\n");
    }
  });

  test("a capture started after the flash is incomplete too", async () => {
    const session = new SerialCaptureSession(fakeSerialBackend());
    session.noteFlash();
    session.start();

    const result = await session.stop();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complete).toBe(false);
      expect(result.value.missed.map((event) => event.kind)).toEqual(["flash"]);
    }
  });

  test("stopping a capture that never started is a failure", async () => {
    const session = new SerialCaptureSession(fakeSerialBackend());
    const result = await session.stop();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FAILED");
      expect(result.reason).toContain("not started");
    }
  });

  test("starting twice is refused", () => {
    const session = new SerialCaptureSession(fakeSerialBackend());
    expect(session.start().ok).toBe(true);
    const second = session.start();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("INVALID_REQUEST");
  });
});

describe("serial backend", () => {
  test("without a serial section the backend is NOT_AVAILABLE", () => {
    const profile = profileWithSerial();
    const backend = createSerialBackend(profile);
    expect(backend.ok).toBe(false);
    if (!backend.ok) expect(backend.reason).toContain("seriale.porta");
  });

  test("without a capture command the backend is NOT_AVAILABLE", () => {
    const profile = profileWithSerial('seriale: { porta: "/dev/null", baud: 115200 }');
    const backend = createSerialBackend(profile);
    expect(backend.ok).toBe(false);
    if (!backend.ok) expect(backend.reason).toContain("seriale.comando");
  });

  test("a missing helper binary is NOT_AVAILABLE, not an empty capture", () => {
    const profile = profileWithSerial(
      'seriale: { porta: "/dev/null", baud: 115200, comando: "serial-helper {porta} {baud}" }',
    );
    const backend = createSerialBackend(profile, { resolve: none });
    expect(backend.ok).toBe(false);
    if (!backend.ok) {
      expect(backend.code).toBe("NOT_AVAILABLE");
      expect(backend.reason).toContain("serial-helper");
    }
  });
});
