import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/app/StatusIndicator";
import { Loader2, Sparkles } from "lucide-react";
import {
  boardStateFor,
  capabilityLabel,
  capabilityTone,
  connectionLabel,
  connectionTone,
  runnerLabel,
  runnerTone,
  type EnvironmentStatus,
} from "@/lib/core/environmentStatus";

const NO_BOARD = "__none__";

export interface NewProjectConfig {
  name: string;
  rtos: "freertos" | "zephyr";
  board: string | null;
  requirements: string;
}

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (config: NewProjectConfig) => void;
  isLoading?: boolean;
  /** Real environment status: decides which boards can be offered. */
  environment?: EnvironmentStatus;
}

/** Same rules as the server-side fallback in `detectProjectName`. */
function slugName(value: string): string {
  const token = value
    .split(/\s+/)
    .find((word) => /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(word));
  const base = (token ?? "firmware").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return base === "" ? "firmware" : base;
}

export function NewProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  isLoading,
  environment,
}: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [rtos, setRtos] = useState<"freertos" | "zephyr">("zephyr");
  const [boardChoice, setBoardChoice] = useState<string>(NO_BOARD);
  const [manualBoard, setManualBoard] = useState("");
  const [requirements, setRequirements] = useState("");

  // Only boards the doctor really listed may be presented as selectable.
  const verifiedBoards = useMemo(() => {
    const boards = environment?.zephyr.boardsSupported ?? null;
    if (!boards || boards.length === 0) return null;
    return [...boards].sort();
  }, [environment]);

  const board = verifiedBoards
    ? boardChoice === NO_BOARD
      ? null
      : boardChoice
    : manualBoard.trim() === ""
      ? null
      : manualBoard.trim().toLowerCase();

  const boardState = environment ? boardStateFor(board, environment.zephyr) : null;
  const projectName = name.trim() === "" ? slugName(requirements) : name.trim();
  const canSubmit = requirements.trim().length > 0 && !isLoading;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ name: projectName, rtos, board, requirements });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl tracking-tight">
            <Sparkles className="h-5 w-5 text-primary" />
            New firmware project
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Describe the device and pick the RTOS. A skeleton is created first; nothing is reported
            as verified until a real toolchain exits 0.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Project name
              </label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={slugName(requirements) || "sensor_gateway"}
                className="text-sm"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Stored as <span className="font-mono">{projectName}</span>
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Target RTOS
              </label>
              <Select value={rtos} onValueChange={(value) => setRtos(value as "freertos" | "zephyr")}>
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zephyr">Zephyr</SelectItem>
                  <SelectItem value="freertos">FreeRTOS</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Board</label>
            {verifiedBoards ? (
              <Select value={boardChoice} onValueChange={setBoardChoice}>
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="Select a verified board" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={NO_BOARD}>No board for now</SelectItem>
                  {verifiedBoards.map((boardName) => (
                    <SelectItem key={boardName} value={boardName}>
                      {boardName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={manualBoard}
                onChange={(event) => setManualBoard(event.target.value)}
                placeholder="nucleo_l476rg"
                className="font-mono text-sm"
              />
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {verifiedBoards
                ? `${verifiedBoards.length} boards are listed by \`west boards\` on the build machine.`
                : "The board list has not been read from west (no runner or no diagnostics yet), so any board entered here stays UNKNOWN / NOT VERIFIED."}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Requirements
            </label>
            <Textarea
              value={requirements}
              onChange={(event) => setRequirements(event.target.value)}
              placeholder="e.g. read a temperature sensor every second and log it over UART, with a 512-byte stack budget"
              className="min-h-[120px] resize-none text-sm"
            />
          </div>

          {/* ------------------------------------- configuration summary --- */}
          <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
            <p className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
              Project configuration
            </p>
            <dl className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
              <SummaryRow label="RTOS">{rtos === "zephyr" ? "Zephyr" : "FreeRTOS"}</SummaryRow>
              <SummaryRow label="Board">
                <span className="font-mono">{board ?? "not set"}</span>
                {boardState ? (
                  <StatusBadge
                    className="ml-2"
                    tone={capabilityTone(boardState.state)}
                    label={capabilityLabel(boardState.state)}
                  />
                ) : null}
              </SummaryRow>
              <SummaryRow label="AI provider">
                {environment ? (
                  <>
                    {environment.llm.provider}
                    <StatusBadge
                      className="ml-2"
                      tone={connectionTone(environment.llm.state)}
                      label={connectionLabel(environment.llm.state)}
                    />
                  </>
                ) : (
                  "unknown"
                )}
              </SummaryRow>
              <SummaryRow label="AI model">{environment?.llm.model ?? "not set"}</SummaryRow>
              <SummaryRow label="Build runner">
                {environment ? (
                  <StatusBadge
                    tone={runnerTone(environment.runner.state)}
                    label={runnerLabel(environment.runner.state)}
                  />
                ) : (
                  "unknown"
                )}
              </SummaryRow>
              <SummaryRow label="Build environment">
                {environment ? (
                  <StatusBadge
                    tone={capabilityTone(environment.toolchain)}
                    label={capabilityLabel(environment.toolchain)}
                  />
                ) : (
                  "unknown"
                )}
              </SummaryRow>
            </dl>
            {rtos === "freertos" ? (
              <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                FreeRTOS has no real toolchain diagnostic yet: the build capability will be reported
                as NOT AVAILABLE / NOT CONFIGURED, never as ready.
              </p>
            ) : null}
            {environment && environment.toolchain !== "READY" ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                The build environment is not verified, so the first turn will save files but report
                the build as NOT AVAILABLE until a runner with a Zephyr toolchain is configured.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isLoading ? "Generating..." : "Create project"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-32 shrink-0 text-[11px] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1">{children}</dd>
    </div>
  );
}
