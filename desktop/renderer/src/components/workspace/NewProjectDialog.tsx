import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Sparkles } from "lucide-react";

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (prompt: string, rtos: "freertos" | "zephyr") => void;
  isLoading?: boolean;
}

export function NewProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  isLoading,
}: NewProjectDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [rtos, setRtos] = useState<"freertos" | "zephyr">("zephyr");

  const handleSubmit = () => {
    if (!prompt.trim() || isLoading) return;
    onSubmit(prompt, rtos);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl tracking-tight">
            <Sparkles className="h-5 w-5 text-primary" />
            New embedded project
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Describe the device and choose the RTOS. The agent will generate a
            structured firmware project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Target RTOS
            </label>
            <Select
              value={rtos}
              onValueChange={(v) => setRtos(v as "freertos" | "zephyr")}
            >
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zephyr">Zephyr</SelectItem>
                <SelectItem value="freertos">FreeRTOS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Requirements
            </label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Build a Zephyr project for an STM32 Nucleo L476RG that reads a temperature sensor every second and logs via UART..."
              className="min-h-[140px] resize-none text-sm"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading || !prompt.trim()}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isLoading ? "Generating..." : "Generate project"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
