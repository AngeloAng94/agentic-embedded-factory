import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (message: string) => void;
  isLoading?: boolean;
  disabled?: boolean;
}

export function ChatPanel({
  messages,
  onSend,
  isLoading,
  disabled,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = () => {
    if (!input.trim() || isLoading || disabled) return;
    onSend(input.trim());
    setInput("");
  };

  return (
    <div className="flex h-full flex-col border-l border-border/60 bg-card/30">
      <div className="border-b border-border/60 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Agent Chat
      </div>
      <div className="flex-1 space-y-4 overflow-auto p-4">
        {messages.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">
            Describe the embedded product you want to build.
          </p>
        )}
        {messages.map((msg, index) => (
          <div
            key={index}
            className={cn(
              "flex gap-3",
              msg.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            {msg.role !== "user" && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Bot className="h-4 w-4" />
              </div>
            )}
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                msg.role === "user"
                  ? "rounded-br-none bg-primary text-primary-foreground"
                  : "rounded-bl-none bg-muted text-foreground",
              )}
            >
              {msg.content}
            </div>
            {msg.role === "user" && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                <User className="h-4 w-4" />
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
            Agent is thinking...
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-border/60 p-4">
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Describe your firmware product..."
            className="min-h-[80px] resize-none text-sm"
            disabled={disabled || isLoading}
          />
          <Button
            onClick={handleSubmit}
            disabled={disabled || isLoading || !input.trim()}
            className="shrink-0 self-end rounded-full px-4"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
