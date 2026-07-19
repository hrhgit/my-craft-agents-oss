import type { AssistantMessage } from "@mortise/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mortise/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mortise/pi-tui";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function isWebSearchEnabled(systemPrompt: string): boolean {
  return (
    systemPrompt.includes("built-in web_search capability") ||
    systemPrompt.includes("Built-in web search is unavailable")
  );
}

export default function (pi: ExtensionAPI) {
  let contextGeneration = 0;
  let currentContext: ExtensionContext | undefined;

  const renderFooter = (ctx: ExtensionContext, generation: number) => {
    try {
      if (!ctx.hasUI) return;
      ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          if (generation !== contextGeneration || currentContext !== ctx) {
            return [];
          }
          try {
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (
              entry.type === "message" &&
              entry.message.role === "assistant"
            ) {
              const message = entry.message as AssistantMessage;
              totalInput += message.usage.input;
              totalOutput += message.usage.output;
              totalCacheRead += message.usage.cacheRead;
              totalCacheWrite += message.usage.cacheWrite;
              totalCost += message.usage.cost.total;
            }
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow =
            contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent =
            contextUsage?.percent != null
              ? contextUsage.percent.toFixed(1)
              : "?";

          let pwd = ctx.sessionManager.getCwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          const branch = footerData.getGitBranch();
          if (branch) {
            pwd = `${pwd} (${branch})`;
          }

          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
          }

          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead)
            statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite)
            statsParts.push(`W${formatTokens(totalCacheWrite)}`);

          const usingSubscription = ctx.model
            ? ctx.modelRegistry.isUsingOAuth(ctx.model)
            : false;
          if (totalCost || usingSubscription) {
            statsParts.push(
              `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
            );
          }

          const contextPercentDisplay =
            contextPercent === "?"
              ? `?/${formatTokens(contextWindow)} (auto)`
              : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
          if (contextPercentValue > 90) {
            statsParts.push(theme.fg("error", contextPercentDisplay));
          } else if (contextPercentValue > 70) {
            statsParts.push(theme.fg("warning", contextPercentDisplay));
          } else {
            statsParts.push(contextPercentDisplay);
          }

          let statsLeft = statsParts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const webSearchEnabled = isWebSearchEnabled(ctx.getSystemPrompt());
          const webSearchStateText = `web search: ${theme.fg(webSearchEnabled ? "success" : "muted", webSearchEnabled ? "on" : "off")}`;

          const modelName = ctx.model?.id || "no-model";
          let rightSideWithoutProvider = `${webSearchStateText} ${modelName}`;
          if (ctx.model?.reasoning) {
            const level = pi.getThinkingLevel();
            rightSideWithoutProvider =
              level === "off"
                ? `${webSearchStateText} ${modelName} • thinking off`
                : `${webSearchStateText} ${modelName} • ${level}`;
          }

          let rightSide = rightSideWithoutProvider;
          const providerCount = footerData.getAvailableProviderCount();
          if (providerCount > 1 && ctx.model) {
            rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
              rightSide = rightSideWithoutProvider;
            }
          }

          const rightSideWidth = visibleWidth(rightSide);
          let statsLine: string;
          if (statsLeftWidth + 2 + rightSideWidth <= width) {
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(
                rightSide,
                availableForRight,
                "",
              );
              const truncatedRightWidth = visibleWidth(truncatedRight);
              const padding = " ".repeat(
                Math.max(0, width - statsLeftWidth - truncatedRightWidth),
              );
              statsLine = statsLeft + padding + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const pwdLine = truncateToWidth(
            theme.fg("dim", pwd),
            width,
            theme.fg("dim", "..."),
          );
          const lines = [
            pwdLine,
            theme.fg("dim", statsLeft) +
              theme.fg("dim", statsLine.slice(statsLeft.length)),
          ];

          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitizeStatusText(text))
              .join(" ");
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
          } catch {
            return [];
          }
        },
      };
    });
    } catch {
      if (currentContext === ctx) currentContext = undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    contextGeneration++;
    currentContext = ctx;
    renderFooter(ctx, contextGeneration);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    contextGeneration++;
    currentContext = undefined;
    try {
      if (ctx.hasUI) ctx.ui.setFooter(undefined);
    } catch {
      // Footer cleanup is best-effort during session replacement/reload.
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    currentContext = ctx;
    renderFooter(ctx, contextGeneration);
  });
}
