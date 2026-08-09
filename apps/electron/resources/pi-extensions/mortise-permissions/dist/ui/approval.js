// ../../../../../packages/extension-ui/src/index.ts
function defineExtensionUI(definition2) {
  if (!definition2 || typeof definition2.mount !== "function") {
    throw new TypeError("defineExtensionUI requires a mount function");
  }
  return definition2;
}

// src/approval.ts
var COPY = {
  en: {
    permissionTitle: "Permission required",
    adminTitle: "Administrator approval required",
    tool: "Tool",
    why: "Why",
    impact: "Impact",
    adminLead: (name) => `Installing ${name} needs administrator approval.`,
    systemPrompt: "Your operating system may show its normal password or biometric prompt.",
    allow: "Allow",
    alwaysAllow: "Always allow",
    deny: "Deny",
    approve: "Approve",
    cancel: "Cancel",
    remember: (minutes) => `Remember for ${minutes} min`,
    queue: (count) => `${count - 1} more approval request${count === 2 ? "" : "s"} waiting`,
    tip: "Always allow remembers this tool call for the current session."
  },
  zh: {
    permissionTitle: "\u9700\u8981\u6743\u9650\u786E\u8BA4",
    adminTitle: "\u9700\u8981\u7BA1\u7406\u5458\u6279\u51C6",
    tool: "\u5DE5\u5177",
    why: "\u539F\u56E0",
    impact: "\u5F71\u54CD",
    adminLead: (name) => `\u5B89\u88C5 ${name} \u9700\u8981\u7BA1\u7406\u5458\u6279\u51C6\u3002`,
    systemPrompt: "\u64CD\u4F5C\u7CFB\u7EDF\u53EF\u80FD\u4F1A\u663E\u793A\u5E38\u89C4\u5BC6\u7801\u6216\u751F\u7269\u8BC6\u522B\u63D0\u793A\u3002",
    allow: "\u5141\u8BB8",
    alwaysAllow: "\u59CB\u7EC8\u5141\u8BB8",
    deny: "\u62D2\u7EDD",
    approve: "\u6279\u51C6",
    cancel: "\u53D6\u6D88",
    remember: (minutes) => `\u8BB0\u4F4F ${minutes} \u5206\u949F`,
    queue: (count) => `\u53E6\u6709 ${count - 1} \u4E2A\u6743\u9650\u8BF7\u6C42\u7B49\u5F85\u5904\u7406`,
    tip: "\u201C\u59CB\u7EC8\u5141\u8BB8\u201D\u4EC5\u5728\u5F53\u524D\u4F1A\u8BDD\u4E2D\u8BB0\u4F4F\u8FD9\u6B21\u5DE5\u5177\u8C03\u7528\u3002"
  }
};
function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== void 0) node.textContent = value;
  return node;
}
function icon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("mortise-permission-icon");
  const pathNode = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pathNode.setAttribute("d", path);
  svg.append(pathNode);
  return svg;
}
var definition = defineExtensionUI({
  mount(context) {
    const copy = COPY[context.locale.toLowerCase().startsWith("zh") ? "zh" : "en"];
    const channel = context.backend.channel("permission-approval", { scope: "session" });
    let request = null;
    let queueLength = 0;
    let sending = false;
    const root = element("div", "mortise-permission-surface");
    const send = async (allowed, options = {}) => {
      if (!request || sending) return;
      sending = true;
      render();
      try {
        await channel.send({
          type: "respond",
          requestId: request.requestId,
          allowed,
          ...options.alwaysAllow ? { alwaysAllow: true } : {},
          ...options.rememberForMinutes ? { rememberForMinutes: options.rememberForMinutes } : {}
        });
      } finally {
        sending = false;
        render();
      }
    };
    const button = (label, semanticId, className, path, action) => {
      const node = element("button", `mortise-permission-button ${className}`);
      node.type = "button";
      node.disabled = sending;
      node.dataset.mortiseUiSemantic = semanticId;
      node.dataset.mortiseSemanticId = semanticId;
      node.append(icon(path), element("span", void 0, label));
      node.addEventListener("click", action, { signal: context.signal });
      return node;
    };
    const render = () => {
      root.replaceChildren();
      if (!request) return;
      const card = element("section", "mortise-permission-card");
      card.setAttribute("aria-live", "polite");
      const body = element("div", "mortise-permission-body");
      const title = element("div", "mortise-permission-title");
      title.append(icon("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"), element("span", void 0, request.type === "admin_approval" ? copy.adminTitle : copy.permissionTitle));
      body.append(title);
      const description = element("div", "mortise-permission-description");
      if (request.type === "admin_approval") {
        description.append(copy.adminLead(request.appName ?? request.toolName));
        if (request.requiresSystemPrompt) description.append(` ${copy.systemPrompt}`);
        description.append(document.createElement("br"), element("strong", void 0, `${copy.why}:`), ` ${request.reason ?? request.description}`);
        if (request.impact) description.append(document.createElement("br"), element("strong", void 0, `${copy.impact}:`), ` ${request.impact}`);
      } else {
        description.append(element("strong", void 0, `${copy.tool}:`), ` ${request.toolName}`, document.createElement("br"), request.description);
      }
      body.append(description);
      if (request.command) body.append(element("pre", "mortise-permission-command", request.command));
      if (queueLength > 1) body.append(element("div", "mortise-permission-queue", copy.queue(queueLength)));
      const actions = element("div", "mortise-permission-actions");
      if (request.type === "admin_approval") {
        const remember = element("label", "mortise-permission-remember");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "mortise-permission-switch";
        input.dataset.mortiseUiSemantic = "permissions.remember";
        input.dataset.mortiseSemanticId = "permissions.remember";
        const minutes = Math.min(Math.max(Math.floor(request.rememberForMinutes ?? 10), 1), 60);
        remember.append(input, element("span", void 0, copy.remember(minutes)));
        actions.append(
          button(copy.approve, "permissions.approve", "primary", "M20 6 9 17l-5-5", () => void send(true, input.checked ? { rememberForMinutes: minutes } : {})),
          button(copy.cancel, "permissions.cancel", "danger", "M18 6 6 18M6 6l12 12", () => void send(false)),
          element("span", "mortise-permission-spacer"),
          remember
        );
      } else {
        actions.append(
          button(copy.allow, "permissions.allow", "primary", "M20 6 9 17l-5-5", () => void send(true)),
          button(copy.alwaysAllow, "permissions.always-allow", "secondary", "M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5", () => void send(true, { alwaysAllow: true })),
          button(copy.deny, "permissions.deny", "danger", "M18 6 6 18M6 6l12 12", () => void send(false)),
          element("span", "mortise-permission-tip", copy.tip)
        );
      }
      card.append(body, actions);
      root.append(card);
    };
    const apply = (snapshot) => {
      const state = snapshot?.state;
      request = state?.request ?? null;
      queueLength = typeof state?.queueLength === "number" ? state.queueLength : request ? 1 : 0;
      sending = false;
      render();
    };
    const unsubscribe = channel.subscribe(apply);
    apply(channel.getSnapshot());
    context.root.append(root);
    return () => {
      unsubscribe();
      context.root.replaceChildren();
    };
  }
});
var mount = definition.mount;
export {
  definition,
  mount
};
