import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const knowledgeSeed = [
  {
    rtos: "zephyr" as const,
    category: "structure",
    title: "Zephyr Project Layout",
    content: `
A minimal Zephyr application has the following layout:
- CMakeLists.txt: declares project, target board and sources.
- prj.conf: Kconfig fragments for the application.
- boards/<board>.overlay: device tree overlay for extra peripherals (optional).
- src/main.c: application entry point with #include <zephyr/kernel.h>.
- src/<modules>.c/h: driver wrappers and application logic.

Build with: west build -b <board> -p auto
    `.trim(),
    tags: ["zephyr", "west", "build"],
  },
  {
    rtos: "zephyr" as const,
    category: "pattern",
    title: "Zephyr main.c template",
    content: `
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

int main(void) {
    printk("Hello from Zephyr on %s\\n", CONFIG_BOARD);
    while (1) {
        k_sleep(K_SECONDS(1));
    }
    return 0;
}
    `.trim(),
    tags: ["zephyr", "template"],
  },
  {
    rtos: "zephyr" as const,
    category: "checklist",
    title: "Zephyr RTOS Checklist",
    content: `
- prj.conf enables CONFIG_* needed by the application.
- Device tree overlay matches the board pinmux/aliases.
- CMakeLists.txt finds Zephyr via find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE}).
- main.c uses kernel.h and does not block critical ISR latency.
- Stack sizes are verified with CONFIG_MAIN_STACK_SIZE.
    `.trim(),
    tags: ["zephyr", "checklist"],
  },
  {
    rtos: "freertos" as const,
    category: "structure",
    title: "FreeRTOS Project Layout",
    content: `
A vendor-agnostic FreeRTOS project typically contains:
- CMakeLists.txt or Makefile: build rules, include paths, source files.
- FreeRTOSConfig.h: kernel configuration (clock, heap, hooks).
- src/main.c: creates tasks, queues, timers, starts scheduler.
- src/app/: application logic separated from hardware.
- src/drivers/: HAL wrappers and low-level drivers.
- tests/: unit tests with mocked kernel APIs.
    `.trim(),
    tags: ["freertos", "build"],
  },
  {
    rtos: "freertos" as const,
    category: "pattern",
    title: "FreeRTOS static task pattern",
    content: `
#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"

#define TASK_STACK_SIZE 256
#define TASK_PRIORITY   1

static StaticTask_t taskBuffer;
static StackType_t  stackBuffer[TASK_STACK_SIZE];
static TaskHandle_t taskHandle;

static void appTask(void *pvParameters) {
    (void)pvParameters;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void appTaskCreate(void) {
    taskHandle = xTaskCreateStatic(
        appTask, "app", TASK_STACK_SIZE, NULL,
        TASK_PRIORITY, stackBuffer, &taskBuffer);
}
    `.trim(),
    tags: ["freertos", "static", "task"],
  },
  {
    rtos: "freertos" as const,
    category: "checklist",
    title: "FreeRTOS RTOS Checklist",
    content: `
- FreeRTOSConfig.h matches the MCU and tick frequency.
- Static allocation used where possible (configSUPPORT_STATIC_ALLOCATION).
- ISRs use FromISR API variants only.
- Priority inversion handled with priority inheritance if available.
- Stack overflow checking enabled during development.
- No dynamic memory in deterministic paths.
    `.trim(),
    tags: ["freertos", "checklist"],
  },
  {
    rtos: "general" as const,
    category: "best_practice",
    title: "Embedded Safety Rules",
    content: `
- Prefer static allocation; avoid malloc/free in real-time paths.
- Keep ISRs short; defer work to tasks via notifications or queues.
- Use mutexes/semapphores with timeout, never block forever.
- Validate pointer arguments and array bounds.
- Enable watchdog and stack overflow checks.
- Never call non-reentrant libc functions from ISRs.
    `.trim(),
    tags: ["safety", "general"],
  },
];

export const seedKnowledgeBase = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("knowledgeBase")
      .withIndex("by_rtos_category", (q) =>
        q.eq("rtos", "zephyr").eq("category", "structure"),
      )
      .take(1);
    if (existing.length > 0) {
      return { inserted: 0, reason: "already seeded" };
    }
    for (const item of knowledgeSeed) {
      await ctx.db.insert("knowledgeBase", item);
    }
    return { inserted: knowledgeSeed.length };
  },
});

export const listByRtos = query({
  args: { rtos: v.union(v.literal("freertos"), v.literal("zephyr"), v.literal("general")) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("knowledgeBase")
      .withIndex("by_rtos_category", (q) => q.eq("rtos", args.rtos))
      .collect();
  },
});

export const listByCategory = query({
  args: {
    rtos: v.union(v.literal("freertos"), v.literal("zephyr"), v.literal("general")),
    category: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("knowledgeBase")
      .withIndex("by_rtos_category", (q) =>
        q.eq("rtos", args.rtos).eq("category", args.category),
      )
      .collect();
  },
});
