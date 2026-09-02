import { Moon, Sun } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { StatusDot } from "../components/ui/status-dot.js";
import { Heading, Label, Text } from "../components/ui/typography.js";
import type { StudioColorScheme } from "./color-scheme.js";

export function StudioHeader({
  colorScheme,
  connected,
  onToggleColorScheme,
}: {
  readonly colorScheme: StudioColorScheme;
  readonly connected: boolean;
  readonly onToggleColorScheme: () => void;
}) {
  const showsDarkScheme = colorScheme === "dark";

  return (
    <header className="studio-header">
      <div>
        <Label as="p" className="eyebrow">
          Seqlane / local session
        </Label>
        <Heading as="h1" size="product">
          Seqlane Studio
        </Heading>
        <Text as="p" className="lede" tone="muted" variant="meta">
          Read-only inspection for concurrent runs.
        </Text>
      </div>
      <div className="studio-header-actions">
        <Button
          className="color-scheme-toggle"
          size="compact"
          aria-label={`Switch to ${showsDarkScheme ? "light" : "dark"} scheme`}
          aria-pressed={showsDarkScheme}
          onClick={onToggleColorScheme}
        >
          {showsDarkScheme ? (
            <Sun aria-hidden="true" />
          ) : (
            <Moon aria-hidden="true" />
          )}
          {showsDarkScheme ? "Light" : "Dark"}
        </Button>
        <div
          className={
            connected ? "connection-status connected" : "connection-status"
          }
        >
          <StatusDot tone={connected ? "positive" : "neutral"} />
          {connected ? "Live" : "Connecting"}
        </div>
      </div>
    </header>
  );
}
