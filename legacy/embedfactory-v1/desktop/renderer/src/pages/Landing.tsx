import { useNavigate } from "react-router";
import { Button } from "../components/ui/button";
import { Cpu, Zap, ShieldCheck, Workflow, Layers } from "lucide-react";

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Cpu className="h-4 w-4" />
            </div>
            <span className="text-lg font-semibold tracking-tight">EmbedFactory</span>
          </div>
          <Button onClick={() => navigate("/dashboard")} className="rounded-full px-6">
            Open Workspace
          </Button>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 pt-20 pb-24">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-0 left-1/2 h-[600px] w-[600px] -translate-x-1/2 rounded-full bg-gradient-to-br from-muted/40 to-transparent blur-3xl" />
        </div>
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/40 px-4 py-1.5 text-xs font-medium text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Desktop Edition — 100% Offline
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            Build verified firmware
            <br />
            <span className="text-muted-foreground">locally, with AI.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Describe your embedded product in plain language. EmbedFactory generates
            Zephyr or FreeRTOS projects, produces code, and runs build-verify loops
            — all on your machine, no cloud required.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" onClick={() => navigate("/dashboard")} className="rounded-full px-8">
              Open workspace
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border/60 bg-muted/20 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: <Layers className="h-5 w-5" />, title: "RTOS skeletons", desc: "Zephyr west/CMake or vendor-ready FreeRTOS projects." },
              { icon: <Workflow className="h-5 w-5" />, title: "Build & verify", desc: "Simulated builds, lint, and tests in a transparent loop." },
              { icon: <ShieldCheck className="h-5 w-5" />, title: "Safety gate", desc: "Static analysis flags dynamic allocation and ISR misuse." },
              { icon: <Zap className="h-5 w-5" />, title: "100% local", desc: "SQLite database, Ollama AI, no cloud dependency." },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl border border-border/60 bg-card p-6">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">{f.icon}</div>
                <h3 className="text-base font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-border/60 px-6 py-6 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} EmbedFactory Desktop Edition
      </footer>
    </div>
  );
}
