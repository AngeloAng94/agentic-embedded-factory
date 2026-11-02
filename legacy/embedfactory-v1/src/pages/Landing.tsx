import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Cpu,
  Layers,
  MessageSquare,
  ShieldCheck,
  Workflow,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router";
import logo from "@/assets/logo.svg";

const fadeIn = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0 },
};

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      className="min-h-screen flex flex-col bg-background text-foreground"
    >
      {/* Navbar */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <a
            href="/"
            className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity"
          >
            <img src={logo} alt="logo" className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight">
              EmbedFactory
            </span>
          </a>
          <nav className="hidden items-center gap-8 text-sm font-medium text-muted-foreground md:flex">
            <a href="#features" className="hover:text-foreground transition-colors">
              Features
            </a>
            <a href="#workflow" className="hover:text-foreground transition-colors">
              Workflow
            </a>
            <a href="#safety" className="hover:text-foreground transition-colors">
              Safety
            </a>
          </nav>
          <div className="flex items-center gap-3">
            {!isLoading && isAuthenticated ? (
              <Button
                onClick={() => navigate("/dashboard")}
                className="rounded-full px-6"
              >
                Dashboard
              </Button>
            ) : (
              <Button
                onClick={() => navigate("/auth")}
                variant="outline"
                className="rounded-full px-6"
              >
                Sign in
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative flex-1 overflow-hidden px-6 pt-20 pb-24 lg:pt-32">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-0 left-1/2 h-[600px] w-[600px] -translate-x-1/2 rounded-full bg-gradient-to-br from-muted/40 to-transparent blur-3xl" />
        </div>
        <div className="mx-auto max-w-5xl text-center">
          <motion.div
            variants={fadeIn}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/40 px-4 py-1.5 text-xs font-medium text-muted-foreground"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            AI Agentic Firmware Factory
          </motion.div>
          <motion.h1
            variants={fadeIn}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="mx-auto max-w-4xl text-4xl font-bold tracking-tight text-foreground sm:text-6xl lg:text-7xl"
          >
            Build embedded firmware
            <br />
            <span className="text-muted-foreground">you can actually verify.</span>
          </motion.h1>
          <motion.p
            variants={fadeIn}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg"
          >
            Describe your product in plain language. EmbedFactory generates the
            Zephyr or FreeRTOS skeleton, configures the board, produces code, and
            runs a build-verify loop — all in one workspace.
          </motion.p>
          <motion.div
            variants={fadeIn}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Button
              size="lg"
              onClick={() => navigate(isAuthenticated ? "/dashboard" : "/auth")}
              className="rounded-full px-8 shadow-sm"
            >
              {isAuthenticated ? "Open workspace" : "Get started"}
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => navigate("/auth")}
              className="rounded-full px-8"
            >
              View demo
            </Button>
          </motion.div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border/60 bg-muted/20 px-6 py-24">
        <div className="mx-auto max-w-7xl">
          <div className="mb-12 max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight">
              Everything to ship an RTOS project — with real build evidence.
            </h2>
            <p className="mt-3 text-muted-foreground">
              From natural-language requirement to a structured, buildable
              firmware repository — with traceability at every step.
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              icon={<MessageSquare className="h-5 w-5" />}
              title="Conversational capture"
              description="Extract board, MCU, peripherals, timing and memory constraints from natural language."
            />
            <FeatureCard
              icon={<Cpu className="h-5 w-5" />}
              title="RTOS skeletons"
              description="Generate Zephyr west/CMake/Kconfig overlays or vendor-ready FreeRTOS projects."
            />
            <FeatureCard
              icon={<Layers className="h-5 w-5" />}
              title="Agentic code generation"
              description="Drivers, task orchestration, state machines, and HAL wrappers produced incrementally."
            />
            <FeatureCard
              icon={<Workflow className="h-5 w-5" />}
              title="Build & verify loop"
              description="Real west/CMake builds and static analysis loop until the project compiles. No simulated results, ever."
            />
            <FeatureCard
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Safety gate"
              description="Static analysis flags dynamic allocation, ISR misuse, and real-time hazards."
            />
            <FeatureCard
              icon={<Zap className="h-5 w-5" />}
              title="Traceable decisions"
              description="Every technical choice, diff and patch is logged and reproducible."
            />
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-12 text-center text-3xl font-bold tracking-tight">
            How it works
          </h2>
          <div className="grid gap-8 md:grid-cols-2">
            {[
              {
                step: "01",
                title: "Describe",
                text: "Tell the agent what the device must do, which board you target, and which RTOS you prefer.",
              },
              {
                step: "02",
                title: "Generate",
                text: "The system proposes a baseline, creates the repository skeleton, and writes the first firmware files.",
              },
              {
                step: "03",
                title: "Verify",
                text: "Build, lint and test run in a transparent loop. Errors are analysed and patched iteratively.",
              },
              {
                step: "04",
                title: "Ship",
                text: "Export a ready-to-build project (ZIP) with sources, configs, README and a manifest carrying the real verification status.",
              },
            ].map((item) => (
              <motion.div
                key={item.step}
                whileHover={{ y: -4 }}
                className="rounded-2xl border border-border/70 bg-card p-8 transition-shadow hover:shadow-sm"
              >
                <span className="text-4xl font-bold text-muted-foreground/40">
                  {item.step}
                </span>
                <h3 className="mt-4 text-xl font-semibold tracking-tight">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {item.text}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border/60 bg-muted/20 px-6 py-20">
        <div className="mx-auto max-w-3xl rounded-3xl bg-card px-8 py-14 text-center ring-1 ring-border/70">
          <h2 className="text-3xl font-bold tracking-tight">
            Ready to build firmware you can verify?
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-muted-foreground">
            Create your first project and watch the agent generate a structured
            RTOS repository in seconds.
          </p>
          <Button
            size="lg"
            onClick={() => navigate(isAuthenticated ? "/dashboard" : "/auth")}
            className="mt-8 rounded-full px-8"
          >
            {isAuthenticated ? "Go to workspace" : "Get started"}
          </Button>
        </div>
      </section>

      <footer className="border-t border-border/60 px-6 py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} EmbedFactory. Built for embedded engineers.
      </footer>
    </motion.div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <motion.div
      whileHover={{ y: -4 }}
      className="group rounded-2xl border border-border/60 bg-card p-6 transition-shadow hover:shadow-sm"
    >
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
        {icon}
      </div>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </motion.div>
  );
}
