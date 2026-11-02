import type { ReactNode } from "react";
import { LogOut, Cpu } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/dashboard", label: "Workspace" },
  { to: "/environment", label: "Environment" },
  { to: "/settings", label: "Settings" },
];

/**
 * One header for every authenticated page, so Workspace, Environment and
 * Settings are always reachable without duplicating the auth chrome.
 */
export function ControlPlaneHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-6 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Cpu className="h-4 w-4" />
        </div>
        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold tracking-tight">{title}</h1>
          <span className="hidden text-[10px] tracking-widest text-muted-foreground uppercase sm:inline">
            EmbedFactory
          </span>
        </div>
      </div>

      <nav className="flex items-center gap-1">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="flex items-center gap-2">
        {children}
        <Button
          size="sm"
          variant="outline"
          onClick={handleSignOut}
          className="gap-1.5 rounded-full"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </header>
  );
}
