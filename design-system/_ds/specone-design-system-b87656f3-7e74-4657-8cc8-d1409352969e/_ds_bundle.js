/* @ds-bundle: {"format":3,"namespace":"SpecOneDesignSystem_b87656","components":[{"name":"AgentMessage","sourcePath":"components/core/AgentMessage.jsx"},{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Callout","sourcePath":"components/core/Callout.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"KanbanCard","sourcePath":"components/core/KanbanCard.jsx"},{"name":"SpecCard","sourcePath":"components/core/SpecCard.jsx"},{"name":"StatusDot","sourcePath":"components/core/StatusDot.jsx"},{"name":"Switch","sourcePath":"components/core/Switch.jsx"},{"name":"Tabs","sourcePath":"components/core/Tabs.jsx"},{"name":"Textarea","sourcePath":"components/core/Textarea.jsx"}],"sourceHashes":{"components/core/AgentMessage.jsx":"88172419df32","components/core/Avatar.jsx":"1c4bb7ba9891","components/core/Badge.jsx":"4cc8957b1478","components/core/Button.jsx":"8853e4bd10cd","components/core/Callout.jsx":"c093c6f54f85","components/core/Card.jsx":"26002e98f0a7","components/core/IconButton.jsx":"81cf155e455c","components/core/Input.jsx":"32d1c8c96951","components/core/KanbanCard.jsx":"fc9c2365e770","components/core/SpecCard.jsx":"e53b88cea036","components/core/StatusDot.jsx":"184d3895862a","components/core/Switch.jsx":"9e9115d9c575","components/core/Tabs.jsx":"99e661068874","components/core/Textarea.jsx":"74a957434a49","ui_kits/orchestrator/App.jsx":"0cd01336253c","ui_kits/orchestrator/Board.jsx":"250068c355e3","ui_kits/orchestrator/Cockpit.jsx":"7c45a32b9157","ui_kits/orchestrator/Review.jsx":"1c66aa2638eb","ui_kits/orchestrator/Session.jsx":"115fc61e8ec2","ui_kits/orchestrator/Shell.jsx":"a15eccdfbb8c","ui_kits/orchestrator/icons.jsx":"8adbe34476bf"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.SpecOneDesignSystem_b87656 = window.SpecOneDesignSystem_b87656 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Avatar.jsx
try { (() => {
/**
 * SpecOne Avatar — agent/model or human identity chip.
 * Agents render as a square-ish teal tile with initials; humans as a circle.
 */
function Avatar({
  name = "",
  kind = "agent",
  size = 30,
  color,
  style
}) {
  const initials = name.split(/[\s·-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const isAgent = kind === "agent";
  const bg = color || (isAgent ? "var(--primary)" : "var(--muted)");
  const fg = color ? "#fff" : isAgent ? "var(--primary-foreground)" : "var(--foreground)";
  return /*#__PURE__*/React.createElement("span", {
    style: {
      width: size,
      height: size,
      flex: "none",
      borderRadius: isAgent ? "var(--radius-md)" : "999px",
      background: bg,
      color: fg,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "var(--font-sans)",
      fontSize: Math.round(size * 0.38),
      fontWeight: 600,
      letterSpacing: "0",
      ...style
    }
  }, initials || "•");
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/AgentMessage.jsx
try { (() => {
/**
 * SpecOne AgentMessage — a turn in the authoring cockpit (monochrome).
 * Agent turns sit in a muted bubble and name the role + model; human turns
 * are filled (primary) and right-aligned. `gate` flags a decision moment
 * with a destructive accent.
 */
function AgentMessage({
  role = "agent",
  agent = "Architect agent",
  model = "Opus",
  children,
  gate = false,
  style
}) {
  const isAgent = role === "agent";
  if (!isAgent) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "flex-end",
        ...style
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        maxWidth: "82%",
        background: "var(--primary)",
        color: "var(--primary-foreground)",
        borderRadius: "var(--radius-lg)",
        padding: "9px 13px",
        fontFamily: "var(--font-sans)",
        fontSize: 14,
        lineHeight: 1.5
      }
    }, children));
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: agent,
    kind: "agent",
    size: 28,
    color: gate ? "var(--destructive)" : undefined
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      marginBottom: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      fontWeight: 600,
      color: gate ? "var(--destructive)" : "var(--foreground)"
    }
  }, agent), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11.5,
      color: "var(--muted-foreground)"
    }
  }, model)), /*#__PURE__*/React.createElement("div", {
    style: {
      background: gate ? "var(--danger-bg)" : "var(--muted)",
      border: `1px solid ${gate ? "color-mix(in srgb, var(--destructive) 40%, var(--border))" : "var(--border)"}`,
      borderRadius: "var(--radius-lg)",
      padding: "10px 13px",
      fontFamily: "var(--font-sans)",
      fontSize: 14,
      lineHeight: 1.55,
      color: "var(--foreground)"
    }
  }, children)));
}
Object.assign(__ds_scope, { AgentMessage });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/AgentMessage.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SpecOne Badge — shadcn badge on the neutral theme.
 * Variants: default (near-black), secondary (gray), outline, destructive.
 * Legacy status `tone` names map onto these monochrome variants.
 */
const TONE_TO_VARIANT = {
  neutral: "secondary",
  draft: "outline",
  review: "secondary",
  approved: "default",
  merged: "secondary",
  teal: "default",
  signal: "destructive",
  danger: "destructive",
  ok: "secondary",
  warn: "outline"
};
function Badge({
  variant,
  tone,
  solid,
  // legacy, ignored
  children,
  style,
  ...rest
}) {
  const v = variant || TONE_TO_VARIANT[tone] || "secondary";
  const variants = {
    default: {
      background: "var(--primary)",
      color: "var(--primary-foreground)",
      border: "1px solid transparent"
    },
    secondary: {
      background: "var(--secondary)",
      color: "var(--secondary-foreground)",
      border: "1px solid transparent"
    },
    outline: {
      background: "transparent",
      color: "var(--foreground)",
      border: "1px solid var(--border)"
    },
    destructive: {
      background: "var(--destructive)",
      color: "#fff",
      border: "1px solid transparent"
    }
  };
  const skin = variants[v] || variants.secondary;
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      fontFamily: "var(--font-sans)",
      fontSize: 12,
      fontWeight: 500,
      lineHeight: 1.4,
      padding: "1px 8px",
      borderRadius: "var(--radius-sm)",
      whiteSpace: "nowrap",
      width: "fit-content",
      ...skin,
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SpecOne Button — shadcn/ui anatomy on the neutral theme.
 * Default = near-black primary. Variants: secondary, outline, ghost,
 * destructive, link. Sizes: sm / default / lg / icon.
 */
function Button({
  variant = "default",
  size = "default",
  disabled = false,
  iconLeft = null,
  iconRight = null,
  type = "button",
  onClick,
  children,
  style,
  ...rest
}) {
  // normalise legacy names
  const v = {
    primary: "default",
    signal: "default",
    danger: "destructive"
  }[variant] || variant;
  const sz = {
    md: "default"
  }[size] || size;
  const [hover, setHover] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  const sizes = {
    sm: {
      height: 32,
      padding: "0 12px",
      fontSize: 13,
      gap: 6
    },
    default: {
      height: 36,
      padding: "0 16px",
      fontSize: 14,
      gap: 8
    },
    lg: {
      height: 40,
      padding: "0 24px",
      fontSize: 14,
      gap: 8
    },
    icon: {
      height: 36,
      width: 36,
      padding: 0,
      fontSize: 14,
      gap: 0
    }
  };
  const base = sizes[sz] || sizes.default;
  const variants = {
    default: {
      background: "var(--primary)",
      color: "var(--primary-foreground)",
      border: "1px solid transparent",
      boxShadow: "var(--shadow-xs)"
    },
    secondary: {
      background: "var(--secondary)",
      color: "var(--secondary-foreground)",
      border: "1px solid transparent",
      boxShadow: "var(--shadow-xs)"
    },
    outline: {
      background: "var(--background)",
      color: "var(--foreground)",
      border: "1px solid var(--border)",
      boxShadow: "var(--shadow-xs)"
    },
    ghost: {
      background: "transparent",
      color: "var(--foreground)",
      border: "1px solid transparent",
      boxShadow: "none"
    },
    destructive: {
      background: "var(--destructive)",
      color: "#fff",
      border: "1px solid transparent",
      boxShadow: "var(--shadow-xs)"
    },
    link: {
      background: "transparent",
      color: "var(--foreground)",
      border: "1px solid transparent",
      boxShadow: "none",
      textDecoration: hover ? "underline" : "none",
      textUnderlineOffset: 4
    }
  };
  const skin = variants[v] || variants.default;
  const hovers = {
    default: {
      background: "color-mix(in srgb, var(--primary) 90%, var(--background))"
    },
    secondary: {
      background: "color-mix(in srgb, var(--secondary) 80%, var(--background))"
    },
    outline: {
      background: "var(--accent)",
      color: "var(--accent-foreground)"
    },
    ghost: {
      background: "var(--accent)",
      color: "var(--accent-foreground)"
    },
    destructive: {
      background: "color-mix(in srgb, var(--destructive) 90%, black)"
    },
    link: {}
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: base.gap,
      height: base.height,
      width: base.width,
      padding: base.padding,
      fontSize: base.fontSize,
      fontFamily: "var(--font-sans)",
      fontWeight: 500,
      lineHeight: 1,
      borderRadius: "var(--radius-md)",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      whiteSpace: "nowrap",
      transition: "var(--transition-control)",
      outline: "none",
      ...skin,
      ...(hover && !disabled ? hovers[v] : {}),
      ...(focus && !disabled ? {
        boxShadow: "var(--shadow-focus)"
      } : {}),
      ...style
    }
  }, rest), iconLeft ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex"
    }
  }, iconLeft) : null, children, iconRight ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex"
    }
  }, iconRight) : null);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Callout.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SpecOne Callout — shadcn Alert on the neutral theme.
 * Full border + rounded-lg. `default` neutral, `destructive` red.
 * Legacy variants (truth/signal/info/warn/ok) map onto these.
 */
const MAP = {
  truth: "default",
  info: "default",
  signal: "destructive",
  danger: "destructive",
  warn: "warning",
  ok: "success"
};
function Callout({
  variant = "default",
  label,
  children,
  style,
  ...rest
}) {
  const v = MAP[variant] || variant;
  const skins = {
    default: {
      border: "var(--border)",
      bg: "var(--card)",
      title: "var(--foreground)",
      body: "var(--muted-foreground)"
    },
    destructive: {
      border: "color-mix(in srgb, var(--destructive) 40%, var(--border))",
      bg: "var(--danger-bg)",
      title: "var(--destructive)",
      body: "color-mix(in srgb, var(--destructive) 80%, var(--foreground))"
    },
    success: {
      border: "color-mix(in srgb, var(--success) 35%, var(--border))",
      bg: "var(--success-bg)",
      title: "var(--success)",
      body: "var(--foreground)"
    },
    warning: {
      border: "color-mix(in srgb, var(--warning) 35%, var(--border))",
      bg: "var(--warning-bg)",
      title: "var(--warning)",
      body: "var(--foreground)"
    }
  };
  const s = skins[v] || skins.default;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      border: `1px solid ${s.border}`,
      background: s.bg,
      padding: "12px 16px",
      borderRadius: "var(--radius-lg)",
      ...style
    }
  }, rest), label ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 14,
      fontWeight: 600,
      color: s.title,
      marginBottom: 3,
      letterSpacing: "-0.005em"
    }
  }, label) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      lineHeight: 1.55,
      color: s.body
    }
  }, children));
}
Object.assign(__ds_scope, { Callout });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Callout.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SpecOne Card — shadcn card: bg-card, border, rounded-xl, shadow-sm.
 * Variants: default, recessed (muted), boundary (dashed), dark (inverted).
 */
function Card({
  variant = "default",
  padding = 24,
  elevated = true,
  header = null,
  footer = null,
  children,
  style,
  ...rest
}) {
  const variants = {
    default: {
      background: "var(--card)",
      color: "var(--card-foreground)",
      border: "1px solid var(--border)"
    },
    recessed: {
      background: "var(--muted)",
      color: "var(--foreground)",
      border: "1px solid var(--border)"
    },
    boundary: {
      background: "var(--muted)",
      color: "var(--foreground)",
      border: "1px dashed var(--neutral-400)"
    },
    dark: {
      background: "var(--primary)",
      color: "var(--primary-foreground)",
      border: "1px solid var(--primary)"
    }
  };
  const v = variants[variant] || variants.default;
  const dividerColor = variant === "dark" ? "rgba(255,255,255,.12)" : "var(--border)";
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      borderRadius: "var(--radius-xl)",
      boxShadow: elevated && variant !== "boundary" ? "var(--shadow-sm)" : "none",
      overflow: "hidden",
      ...v,
      ...style
    }
  }, rest), header ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "14px 24px",
      borderBottom: `1px solid ${dividerColor}`,
      fontFamily: "var(--font-sans)",
      fontSize: 14,
      fontWeight: 600,
      color: variant === "dark" ? "var(--primary-foreground)" : "var(--foreground)"
    }
  }, header) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding
    }
  }, children), footer ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "14px 24px",
      borderTop: `1px solid ${dividerColor}`
    }
  }, footer) : null);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SpecOne IconButton — square icon-only control (shadcn ghost/outline).
 * Pass a Lucide <svg> as children. Always set `label` for a11y.
 */
function IconButton({
  size = "default",
  variant = "ghost",
  disabled = false,
  label,
  onClick,
  children,
  style,
  ...rest
}) {
  const dims = {
    sm: 32,
    default: 36,
    lg: 40
  }[size] || 36;
  const [hover, setHover] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  const variants = {
    ghost: {
      background: "transparent",
      color: "var(--foreground)",
      border: "1px solid transparent"
    },
    outline: {
      background: "var(--background)",
      color: "var(--foreground)",
      border: "1px solid var(--border)",
      boxShadow: "var(--shadow-xs)"
    },
    secondary: {
      background: "var(--secondary)",
      color: "var(--secondary-foreground)",
      border: "1px solid transparent",
      boxShadow: "var(--shadow-xs)"
    }
  };
  const v = variants[variant] || variants.ghost;
  const hoverStyle = variant === "secondary" ? {
    background: "color-mix(in srgb, var(--secondary) 80%, var(--background))"
  } : {
    background: "var(--accent)",
    color: "var(--accent-foreground)"
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    "aria-label": label,
    title: label,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: dims,
      height: dims,
      borderRadius: "var(--radius-md)",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      transition: "var(--transition-control)",
      outline: "none",
      ...v,
      ...(hover && !disabled ? hoverStyle : {}),
      ...(focus && !disabled ? {
        boxShadow: "var(--shadow-focus)"
      } : {}),
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SpecOne Input — shadcn field: h-9, rounded-md, border, focus ring.
 * Optional mono affix for paths / IDs.
 */
function Input({
  value,
  defaultValue,
  placeholder,
  type = "text",
  disabled = false,
  invalid = false,
  mono = false,
  prefix = null,
  size = "default",
  onChange,
  style,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const heights = {
    sm: 32,
    default: 36,
    lg: 40
  }[size] || 36;
  const borderColor = invalid ? "var(--destructive)" : focus ? "var(--ring)" : "var(--input)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      height: heights,
      background: disabled ? "var(--muted)" : "var(--background)",
      border: `1px solid ${borderColor}`,
      borderRadius: "var(--radius-md)",
      boxShadow: focus ? "var(--shadow-focus)" : "var(--shadow-2xs)",
      transition: "var(--transition-control)",
      overflow: "hidden",
      opacity: disabled ? 0.6 : 1,
      ...style
    }
  }, prefix ? /*#__PURE__*/React.createElement("span", {
    style: {
      paddingLeft: 12,
      color: "var(--muted-foreground)",
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      whiteSpace: "nowrap"
    }
  }, prefix) : null, /*#__PURE__*/React.createElement("input", _extends({
    type: type,
    value: value,
    defaultValue: defaultValue,
    placeholder: placeholder,
    disabled: disabled,
    onChange: onChange,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      flex: 1,
      minWidth: 0,
      border: "none",
      outline: "none",
      background: "transparent",
      padding: prefix ? "0 12px 0 4px" : "0 12px",
      fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
      fontSize: mono ? 13 : 14,
      color: "var(--foreground)"
    }
  }, rest)));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusDot.jsx
try { (() => {
/**
 * SpecOne StatusDot — a small filled circle carrying delivery state.
 * Monochrome-leaning: a restrained green/amber/red set for true status,
 * neutral otherwise. Optional pulse for live work.
 */
const COLORS = {
  running: "var(--foreground)",
  agree: "var(--success)",
  ok: "var(--success)",
  diverge: "var(--destructive)",
  attention: "var(--destructive)",
  waiting: "var(--warning)",
  idle: "var(--neutral-300)",
  done: "var(--foreground)"
};
function StatusDot({
  status = "idle",
  size = 8,
  pulse = false,
  label,
  style
}) {
  const color = COLORS[status] || COLORS.idle;
  const dot = /*#__PURE__*/React.createElement("span", {
    style: {
      width: size,
      height: size,
      borderRadius: "999px",
      background: color,
      display: "inline-block",
      flex: "none",
      animation: pulse ? "specone-pulse 1.8s var(--ease-out) infinite" : "none"
    }
  });
  const keyframes = "@keyframes specone-pulse{0%{box-shadow:0 0 0 0 rgba(115,115,115,.4)}70%{box-shadow:0 0 0 5px rgba(115,115,115,0)}100%{box-shadow:0 0 0 0 rgba(115,115,115,0)}}";
  if (!label) {
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("style", null, keyframes), dot);
  }
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 7,
      ...style
    }
  }, /*#__PURE__*/React.createElement("style", null, keyframes), dot, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      color: "var(--muted-foreground)"
    }
  }, label));
}
Object.assign(__ds_scope, { StatusDot });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusDot.jsx", error: String((e && e.message) || e) }); }

// components/core/KanbanCard.jsx
try { (() => {
/**
 * SpecOne KanbanCard — a card on the delivery board (monochrome).
 * Labelled by harness + model with a live status dot. `needsHuman`
 * raises a destructive accent.
 */
function KanbanCard({
  taskId = "T-0",
  title = "Task",
  status = "running",
  harness = "OpenCode",
  model = "mid-tier",
  needsHuman = false,
  style
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      background: "var(--card)",
      border: `1px solid ${needsHuman ? "color-mix(in srgb, var(--destructive) 45%, var(--border))" : "var(--border)"}`,
      borderLeft: needsHuman ? "3px solid var(--destructive)" : "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      padding: "11px 12px",
      boxShadow: hover ? "var(--shadow-sm)" : "var(--shadow-xs)",
      transition: "var(--transition-control)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--muted-foreground)"
    }
  }, taskId), /*#__PURE__*/React.createElement(__ds_scope.StatusDot, {
    status: needsHuman ? "attention" : status,
    pulse: status === "running" && !needsHuman,
    size: 8
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 13.5,
      fontWeight: 500,
      color: "var(--foreground)",
      lineHeight: 1.35
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      marginTop: 9
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 10.5,
      color: "var(--foreground)",
      background: "var(--secondary)",
      padding: "2px 6px",
      borderRadius: "var(--radius-sm)"
    }
  }, harness), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 10.5,
      color: "var(--muted-foreground)"
    }
  }, model), needsHuman ? /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontFamily: "var(--font-sans)",
      fontSize: 11,
      fontWeight: 500,
      color: "var(--destructive)"
    }
  }, "needs a human") : null));
}
Object.assign(__ds_scope, { KanbanCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/KanbanCard.jsx", error: String((e && e.message) || e) }); }

// components/core/SpecCard.jsx
try { (() => {
/**
 * SpecOne SpecCard — a card in the specification library (monochrome).
 * Mono id, sans title, a status pill with a dot. Hover/selected use the
 * shadcn accent + ring treatment.
 */
const STATUS_DOT = {
  draft: "idle",
  "in-review": "waiting",
  approved: "done",
  merged: "agree"
};
function SpecCard({
  specId = "SPEC-000",
  title = "Untitled specification",
  status = "draft",
  meta = "",
  selected = false,
  onClick,
  style
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      background: selected ? "var(--accent)" : "var(--card)",
      border: `1px solid ${selected ? "var(--neutral-400)" : "var(--border)"}`,
      borderRadius: "var(--radius-xl)",
      padding: "14px 16px",
      cursor: onClick ? "pointer" : "default",
      transition: "var(--transition-control)",
      boxShadow: hover && !selected ? "var(--shadow-sm)" : "var(--shadow-xs)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--muted-foreground)",
      letterSpacing: "0"
    }
  }, specId), /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    variant: "outline"
  }, /*#__PURE__*/React.createElement(__ds_scope.StatusDot, {
    status: STATUS_DOT[status] || "idle",
    size: 7
  }), status)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 15,
      fontWeight: 600,
      letterSpacing: "-0.01em",
      color: "var(--foreground)",
      margin: "8px 0 0",
      lineHeight: 1.3
    }
  }, title), meta ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--muted-foreground)",
      marginTop: 8
    }
  }, meta) : null);
}
Object.assign(__ds_scope, { SpecCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/SpecCard.jsx", error: String((e && e.message) || e) }); }

// components/core/Switch.jsx
try { (() => {
/**
 * SpecOne Switch — runtime-mode / setting toggle. Teal when on.
 */
function Switch({
  checked = false,
  disabled = false,
  onChange,
  label,
  style
}) {
  const toggle = () => {
    if (!disabled && onChange) onChange(!checked);
  };
  const sw = /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "switch",
    "aria-checked": checked,
    disabled: disabled,
    onClick: toggle,
    style: {
      width: 38,
      height: 22,
      borderRadius: 999,
      border: "none",
      padding: 2,
      cursor: disabled ? "not-allowed" : "pointer",
      background: checked ? "var(--primary)" : "var(--input)",
      opacity: disabled ? 0.5 : 1,
      transition: "background var(--dur-base) var(--ease-standard)",
      display: "inline-flex",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 18,
      borderRadius: 999,
      background: "var(--background)",
      boxShadow: "var(--shadow-xs)",
      transform: checked ? "translateX(16px)" : "translateX(0)",
      transition: "transform var(--dur-base) var(--ease-out)"
    }
  }));
  if (!label) return sw;
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      cursor: "pointer",
      ...style
    }
  }, sw, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 14,
      color: "var(--foreground)"
    }
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Switch.jsx", error: String((e && e.message) || e) }); }

// components/core/Tabs.jsx
try { (() => {
/**
 * SpecOne Tabs — shadcn segmented control. A muted track holds the
 * triggers; the active trigger lifts to a white card with a small shadow.
 */
function Tabs({
  tabs = [],
  value,
  defaultValue,
  onChange,
  mono = false,
  style
}) {
  const [internal, setInternal] = React.useState(defaultValue || tabs[0] && tabs[0].id);
  const active = value !== undefined ? value : internal;
  const select = id => {
    if (value === undefined) setInternal(id);
    if (onChange) onChange(id);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 2,
      background: "var(--muted)",
      borderRadius: "var(--radius-lg)",
      padding: 3,
      ...style
    }
  }, tabs.map(t => {
    const on = t.id === active;
    return /*#__PURE__*/React.createElement("button", {
      key: t.id,
      type: "button",
      onClick: () => select(t.id),
      style: {
        appearance: "none",
        border: "none",
        cursor: "pointer",
        padding: "5px 12px",
        borderRadius: "var(--radius-md)",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: 13,
        fontWeight: 500,
        color: on ? "var(--foreground)" : "var(--muted-foreground)",
        background: on ? "var(--background)" : "transparent",
        boxShadow: on ? "var(--shadow-xs)" : "none",
        transition: "var(--transition-control)",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        whiteSpace: "nowrap"
      }
    }, t.label, t.count !== undefined ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: on ? "var(--muted-foreground)" : "var(--neutral-400)"
      }
    }, t.count) : null);
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/core/Textarea.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SpecOne Textarea — shadcn field for longer notes / composer.
 */
function Textarea({
  value,
  defaultValue,
  placeholder,
  rows = 3,
  disabled = false,
  mono = false,
  onChange,
  style,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  return /*#__PURE__*/React.createElement("textarea", _extends({
    value: value,
    defaultValue: defaultValue,
    placeholder: placeholder,
    rows: rows,
    disabled: disabled,
    onChange: onChange,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      width: "100%",
      resize: "vertical",
      border: `1px solid ${focus ? "var(--ring)" : "var(--input)"}`,
      borderRadius: "var(--radius-md)",
      boxShadow: focus ? "var(--shadow-focus)" : "var(--shadow-2xs)",
      background: disabled ? "var(--muted)" : "var(--background)",
      padding: "8px 12px",
      fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
      fontSize: mono ? 13 : 14,
      lineHeight: 1.5,
      color: "var(--foreground)",
      outline: "none",
      transition: "var(--transition-control)",
      ...style
    }
  }, rest));
}
Object.assign(__ds_scope, { Textarea });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Textarea.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orchestrator/App.jsx
try { (() => {
// SpecOne UI kit — top-level app: project picker → shell + screen router.
(function () {
  const Icon = window.SO_Icon;
  const NS = window.SpecOneDesignSystem_b87656;
  const {
    Button,
    Input,
    Badge,
    SpecCard,
    Card,
    Switch,
    StatusDot
  } = NS;
  const {
    SO_AppShell,
    SO_TopBar,
    SO_Wordmark,
    SO_Cockpit,
    SO_Board,
    SO_Review,
    SO_Session
  } = window;

  // ---- Project picker (entry) ----
  function Picker({
    onOpen
  }) {
    const [host, setHost] = React.useState('localhost:4096');
    const projects = [{
      name: 'asset-platform',
      specs: 14,
      status: 'connected'
    }, {
      name: 'billing-core',
      specs: 6,
      status: 'connected'
    }];
    return React.createElement('div', {
      style: {
        height: '100%',
        width: '100%',
        background: 'var(--muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }
    }, React.createElement('div', {
      style: {
        width: 440
      }
    }, React.createElement('div', {
      style: {
        marginBottom: 20,
        display: 'flex',
        justifyContent: 'center'
      }
    }, React.createElement('div', {
      style: {
        background: 'var(--primary)',
        borderRadius: 'var(--radius-xl)',
        padding: '14px 22px'
      }
    }, React.createElement(SO_Wordmark, {
      size: 26,
      onDark: true
    }))), React.createElement('p', {
      style: {
        textAlign: 'center',
        margin: '0 0 22px',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: 'var(--muted-foreground)',
        fontWeight: 500
      }
    }, 'Specification Orchestrator'), React.createElement(Card, null, React.createElement('div', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--foreground)',
        marginBottom: 8
      }
    }, 'Harness host'), React.createElement('div', {
      style: {
        display: 'flex',
        gap: 8,
        marginBottom: 20
      }
    }, React.createElement('div', {
      style: {
        flex: 1
      }
    }, React.createElement(Input, {
      mono: true,
      prefix: 'opencode://',
      value: host,
      onChange: e => setHost(e.target.value)
    })), React.createElement(Button, {
      variant: 'secondary'
    }, 'Connect')), React.createElement('div', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--foreground)',
        marginBottom: 10
      }
    }, 'Projects'), React.createElement('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10
      }
    }, projects.map(p => React.createElement('button', {
      key: p.name,
      onClick: () => onOpen(p),
      style: {
        appearance: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        background: 'var(--background)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '13px 15px',
        display: 'flex',
        alignItems: 'center',
        gap: 12
      }
    }, React.createElement('span', {
      style: {
        color: 'var(--muted-foreground)',
        display: 'flex'
      }
    }, React.createElement(Icon, {
      name: 'server',
      size: 18
    })), React.createElement('div', {
      style: {
        flex: 1
      }
    }, React.createElement('div', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--foreground)'
      }
    }, p.name), React.createElement('div', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--muted-foreground)'
      }
    }, p.specs + ' specifications')), React.createElement(StatusDot, {
      status: 'agree',
      label: p.status
    }), React.createElement('span', {
      style: {
        color: 'var(--neutral-400)',
        display: 'flex'
      }
    }, React.createElement(Icon, {
      name: 'chevron',
      size: 16
    }))))))));
  }

  // ---- Spec library ----
  function Library({
    onOpen
  }) {
    const specs = [{
      specId: 'SPEC-016',
      title: 'Webhook signature verification',
      status: 'draft',
      meta: 'webhook-verify.md · authoring'
    }, {
      specId: 'SPEC-014',
      title: 'Payment retry with idempotency keys',
      status: 'in-review',
      meta: 'payment-retry.md · 6 tasks'
    }, {
      specId: 'SPEC-013',
      title: 'Tenant-scoped API rate limits',
      status: 'approved',
      meta: 'rate-limits.md · 5 tasks'
    }, {
      specId: 'SPEC-012',
      title: 'Asset tagging taxonomy',
      status: 'merged',
      meta: 'asset-tagging.md · merged 2d ago'
    }];
    return React.createElement('div', {
      style: {
        height: '100%',
        overflowY: 'auto',
        padding: '22px 24px'
      }
    }, React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 18
      }
    }, React.createElement('div', {
      style: {
        width: 280
      }
    }, React.createElement(Input, {
      placeholder: 'Search specifications…'
    })), React.createElement('div', {
      style: {
        flex: 1
      }
    }), React.createElement(Button, {
      iconLeft: React.createElement(Icon, {
        name: 'plus',
        size: 15
      })
    }, 'New specification')), React.createElement('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 14,
        maxWidth: 880
      }
    }, specs.map(s => React.createElement(SpecCard, {
      key: s.specId,
      ...s,
      onClick: () => onOpen(s)
    }))));
  }
  function Placeholder({
    icon,
    title,
    body
  }) {
    return React.createElement('div', {
      style: {
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 10
      }
    }, React.createElement('span', {
      style: {
        color: 'var(--neutral-400)'
      }
    }, React.createElement(Icon, {
      name: icon,
      size: 28
    })), React.createElement('div', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 17,
        fontWeight: 600,
        color: 'var(--foreground)'
      }
    }, title), React.createElement('div', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        maxWidth: 360,
        textAlign: 'center',
        color: 'var(--muted-foreground)',
        lineHeight: 1.5
      }
    }, body));
  }

  // ---- App ----
  function App() {
    const [project, setProject] = React.useState(null);
    const [view, setView] = React.useState('cockpit');
    const [task, setTask] = React.useState(null);
    if (!project) return React.createElement(Picker, {
      onOpen: p => {
        setProject(p);
        setView('cockpit');
      }
    });
    const crumbsByView = {
      library: ['asset-platform', 'Specifications'],
      cockpit: ['asset-platform', 'SPEC-014', 'Authoring cockpit'],
      review: ['asset-platform', 'SPEC-014', 'Review panel'],
      board: ['asset-platform', 'Delivery board'],
      session: ['asset-platform', 'Board', task && task.taskId || 'Session'],
      audit: ['asset-platform', 'Audit & activity'],
      settings: ['asset-platform', 'Settings']
    };
    let screen,
      actions = null;
    if (view === 'library') {
      screen = React.createElement(Library, {
        onOpen: () => setView('cockpit')
      });
    } else if (view === 'cockpit') {
      screen = React.createElement(SO_Cockpit, {
        onConvene: () => setView('review')
      });
      actions = React.createElement(Button, {
        size: 'sm',
        iconLeft: React.createElement(Icon, {
          name: 'check',
          size: 14
        })
      }, 'Approve & persist');
    } else if (view === 'review') {
      screen = React.createElement(SO_Review, null);
    } else if (view === 'board') {
      screen = React.createElement(SO_Board, {
        onOpen: c => {
          setTask(c);
          setView('session');
        }
      });
    } else if (view === 'session') {
      screen = React.createElement(SO_Session, {
        task,
        onBack: () => setView('board')
      });
    } else if (view === 'audit') {
      screen = React.createElement(Placeholder, {
        icon: 'history',
        title: 'Audit & activity trace',
        body: 'Every governed action — permission decisions and deterministic projections — logged with its trigger. The trace is the audit trail.'
      });
    } else {
      screen = React.createElement(Placeholder, {
        icon: 'settings',
        title: 'Settings',
        body: 'Theme, default runtime mode, harness connections and telemetry.'
      });
    }
    const topActions = React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12
      }
    }, React.createElement(Switch, {
      checked: false,
      label: 'Supervised',
      onChange: () => {}
    }), React.createElement('span', {
      style: {
        color: 'var(--muted-foreground)',
        display: 'flex',
        position: 'relative'
      }
    }, React.createElement(Icon, {
      name: 'bell',
      size: 18
    }), React.createElement('span', {
      style: {
        position: 'absolute',
        top: -1,
        right: -1,
        width: 7,
        height: 7,
        borderRadius: 999,
        background: 'var(--destructive)'
      }
    })), actions);
    const topbar = React.createElement(SO_TopBar, {
      crumbs: crumbsByView[view]
    }, topActions);
    const navActive = view === 'session' ? 'board' : view;
    return React.createElement(SO_AppShell, {
      active: navActive,
      onNav: setView,
      topbar
    }, screen);
  }
  window.SO_App = App;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orchestrator/App.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orchestrator/Board.jsx
try { (() => {
// SpecOne UI kit — Delivery board (kanban projected from harness events).
(function () {
  const Icon = window.SO_Icon;
  const NS = window.SpecOneDesignSystem_b87656;
  const {
    KanbanCard,
    Badge
  } = NS;
  const COLUMNS = [{
    id: 'authoring',
    label: 'Authoring',
    cards: [{
      taskId: 'SPEC-016',
      title: 'Webhook signature verification',
      status: 'running',
      harness: 'OpenCode',
      model: 'Opus'
    }]
  }, {
    id: 'review',
    label: 'In review',
    cards: [{
      taskId: 'SPEC-014',
      title: 'Payment retry with idempotency keys',
      status: 'waiting',
      harness: 'OpenCode',
      model: 'Opus'
    }]
  }, {
    id: 'implementing',
    label: 'Implementing',
    cards: [{
      taskId: 'T-3',
      title: 'Add idempotency_key migration',
      status: 'running',
      harness: 'OpenCode',
      model: 'mid-tier'
    }, {
      taskId: 'T-4',
      title: 'Guard the retry handler',
      status: 'running',
      harness: 'Claude Code',
      model: 'Sonnet'
    }, {
      taskId: 'T-5',
      title: 'Backfill processed events',
      needsHuman: true,
      harness: 'Claude Code',
      model: 'Sonnet'
    }]
  }, {
    id: 'diff',
    label: 'Diff review',
    cards: [{
      taskId: 'T-2',
      title: 'Idempotency key column + index',
      status: 'done',
      harness: 'OpenCode',
      model: 'mid-tier'
    }]
  }, {
    id: 'merged',
    label: 'Merged',
    cards: [{
      taskId: 'SPEC-012',
      title: 'Asset tagging taxonomy',
      status: 'done',
      harness: 'OpenCode',
      model: 'mid-tier'
    }]
  }];
  function Column({
    col,
    onOpen
  }) {
    return React.createElement('div', {
      style: {
        width: 250,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }
    }, React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 4px 12px'
      }
    }, React.createElement('span', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        letterSpacing: '0.03em',
        textTransform: 'uppercase',
        color: 'var(--foreground)',
        fontWeight: 600
      }
    }, col.label), React.createElement('span', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--neutral-400)'
      }
    }, col.cards.length)), React.createElement('div', {
      style: {
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '2px'
      }
    }, col.cards.map(c => React.createElement('div', {
      key: c.taskId,
      onClick: () => onOpen && onOpen(c),
      style: {
        cursor: onOpen ? 'pointer' : 'default'
      }
    }, React.createElement(KanbanCard, c))), col.cards.length === 0 ? React.createElement('div', {
      style: {
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '16px',
        textAlign: 'center',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--neutral-400)'
      }
    }, 'empty') : null));
  }
  function Board({
    onOpen
  }) {
    return React.createElement('div', {
      style: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 24px',
        minHeight: 0
      }
    }, React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 18
      }
    }, React.createElement('p', {
      style: {
        margin: 0,
        maxWidth: 560,
        fontFamily: 'var(--font-sans)',
        fontSize: 13.5,
        lineHeight: 1.5,
        color: 'var(--muted-foreground)'
      }
    }, 'A card moves because the work moved, not because a person dragged it. Columns are computed from frontmatter, session and CI state, projected live from the harness event stream.'), React.createElement('div', {
      style: {
        flex: 1
      }
    }), React.createElement(Badge, {
      variant: 'secondary'
    }, 'event-driven')), React.createElement('div', {
      style: {
        flex: 1,
        display: 'flex',
        gap: 16,
        minHeight: 0,
        overflowX: 'auto'
      }
    }, COLUMNS.map(col => React.createElement(Column, {
      key: col.id,
      col,
      onOpen
    }))));
  }
  window.SO_Board = Board;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orchestrator/Board.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orchestrator/Cockpit.jsx
try { (() => {
// SpecOne UI kit — Authoring cockpit (chat + live spec preview), monochrome.
(function () {
  const Icon = window.SO_Icon;
  const NS = window.SpecOneDesignSystem_b87656;
  const {
    AgentMessage,
    Button,
    Textarea,
    Badge
  } = NS;
  const SEED = [{
    role: 'agent',
    agent: 'Product Owner',
    model: 'Opus',
    text: 'Captured the requirement: payment retries must be idempotent so a duplicated webhook never double-charges. Acceptance criteria drafted as SHALL statements.'
  }, {
    role: 'human',
    text: 'Good. Move the evaluation rules out of scope for v1 and tighten the acceptance criteria.'
  }, {
    role: 'agent',
    agent: 'Technical Architect',
    model: 'Opus',
    text: 'Drafting the data model and API contracts from the codebase. An idempotency key column is added to the payments table; the retry handler keys on it. Preview on the right.'
  }];
  function SpecPreview() {
    const Section = ({
      title,
      items,
      edited
    }) => React.createElement('div', {
      style: {
        marginBottom: 22
      }
    }, React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 6
      }
    }, React.createElement('h3', {
      style: {
        margin: 0,
        fontFamily: 'var(--font-sans)',
        fontSize: 15,
        fontWeight: 600,
        color: 'var(--foreground)',
        letterSpacing: '-0.01em'
      }
    }, title), edited ? React.createElement(Badge, {
      variant: 'outline'
    }, 'editing') : null), React.createElement('div', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        lineHeight: 1.7,
        color: 'var(--muted-foreground)'
      }
    }, items.map((it, i) => React.createElement('div', {
      key: i,
      style: {
        display: 'flex',
        gap: 8
      }
    }, React.createElement('span', {
      style: {
        color: 'var(--neutral-400)',
        flex: 'none'
      }
    }, '·'), React.createElement('span', null, it)))));
    return React.createElement('div', {
      style: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--background)',
        borderLeft: '1px solid var(--border)'
      }
    }, React.createElement('div', {
      style: {
        padding: '12px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 10
      }
    }, React.createElement('span', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--foreground)'
      }
    }, 'specification.md'), React.createElement('span', {
      style: {
        marginLeft: 'auto',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        color: 'var(--muted-foreground)'
      }
    }, 'a view of the working file in the repo')), React.createElement('div', {
      style: {
        padding: '10px 20px',
        background: 'var(--secondary)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        gap: 18,
        flexWrap: 'wrap'
      }
    }, ['status: draft', 'owner: priya.n', 'spec_id: SPEC-014', 'source_of_truth: git'].map((t, i) => React.createElement('span', {
      key: i,
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--muted-foreground)'
      }
    }, t))), React.createElement('div', {
      style: {
        padding: '20px',
        overflowY: 'auto',
        flex: 1
      }
    }, React.createElement(Section, {
      title: 'Requirements',
      items: ['Summary — idempotent payment retry for duplicated webhooks', 'Scope — retry handler, payments schema · evaluation rules out of scope for v1', 'Acceptance — SHALL not double-charge given a repeated event id (WHEN/THEN)', 'Open questions — retention window for processed keys?']
    }), React.createElement(Section, {
      title: 'Design',
      edited: true,
      items: ['Architectural decision — key on a unique idempotency_key column', 'Data model — payments.idempotency_key (unique, indexed)', 'API contracts — POST /retries is idempotent on the key', 'Security — keys scoped per tenant']
    }), React.createElement(Section, {
      title: 'Tasks',
      items: ['Add idempotency_key migration · mid-tier', 'Guard the retry handler · mid-tier', 'Backfill processed events · needs a human', 'Definition of done — typecheck + checks pass']
    })));
  }
  function Cockpit({
    onConvene
  }) {
    const [msgs, setMsgs] = React.useState(SEED);
    const [draft, setDraft] = React.useState('');
    const scroller = React.useRef(null);
    React.useEffect(() => {
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    }, [msgs]);
    const send = () => {
      if (!draft.trim()) return;
      const text = draft.trim();
      setMsgs(m => [...m, {
        role: 'human',
        text
      }]);
      setDraft('');
      setTimeout(() => setMsgs(m => [...m, {
        role: 'agent',
        agent: 'Engineering agent',
        model: 'mid-tier',
        text: 'Updated the tasks and acceptance criteria to match. The change is reflected in the preview on the right.'
      }]), 650);
    };
    return React.createElement('div', {
      style: {
        display: 'flex',
        height: '100%'
      }
    }, React.createElement('div', {
      style: {
        width: 420,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--background)'
      }
    }, React.createElement('div', {
      style: {
        padding: '12px 18px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, React.createElement('span', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: 'var(--muted-foreground)',
        fontWeight: 500
      }
    }, 'Authoring'), React.createElement('div', {
      style: {
        flex: 1
      }
    }), React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      iconLeft: React.createElement(Icon, {
        name: 'users',
        size: 14
      }),
      onClick: onConvene
    }, 'Convene review')), React.createElement('div', {
      ref: scroller,
      style: {
        flex: 1,
        overflowY: 'auto',
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16
      }
    }, msgs.map((m, i) => React.createElement(AgentMessage, {
      key: i,
      role: m.role,
      agent: m.agent,
      model: m.model,
      gate: m.gate
    }, m.text))), React.createElement('div', {
      style: {
        padding: '14px 18px',
        borderTop: '1px solid var(--border)',
        background: 'var(--background)'
      }
    }, React.createElement(Textarea, {
      rows: 2,
      value: draft,
      placeholder: 'Direct the agents…',
      onChange: e => setDraft(e.target.value),
      onKeyDown: e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
      }
    }), React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        marginTop: 10
      }
    }, React.createElement('span', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--neutral-400)'
      }
    }, '⌘↵ to send · Architect · Opus'), React.createElement('div', {
      style: {
        flex: 1
      }
    }), React.createElement(Button, {
      size: 'sm',
      onClick: send
    }, 'Send')))), React.createElement(SpecPreview, null));
  }
  window.SO_Cockpit = Cockpit;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orchestrator/Cockpit.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orchestrator/Review.jsx
try { (() => {
// SpecOne UI kit — Multi-model review panel (monochrome).
(function () {
  const NS = window.SpecOneDesignSystem_b87656;
  const {
    Card,
    StatusDot,
    Button,
    Badge,
    Avatar
  } = NS;
  const REVIEWERS = [{
    name: 'Reviewer A',
    model: 'Opus',
    points: [{
      kind: 'agree',
      text: 'data model agrees with schema'
    }, {
      kind: 'diverge',
      text: 'acceptance criteria too vague'
    }, {
      kind: 'diverge',
      text: 'missing error path in retry API'
    }]
  }, {
    name: 'Reviewer B',
    model: 'GPT-5.5',
    points: [{
      kind: 'diverge',
      text: 'acceptance criteria too vague'
    }, {
      kind: 'agree',
      text: 'scope boundary is clear'
    }, {
      kind: 'diverge',
      text: 'naming clashes with module billing'
    }]
  }, {
    name: 'Reviewer C',
    model: 'Sonnet',
    points: [{
      kind: 'agree',
      text: 'tasks are atomic enough'
    }, {
      kind: 'diverge',
      text: 'missing error path in retry API'
    }, {
      kind: 'agree',
      text: 'definition of done is testable'
    }]
  }];
  function ReviewerCard({
    r,
    onAccept
  }) {
    return React.createElement(Card, {
      padding: 0,
      style: {
        display: 'flex',
        flexDirection: 'column'
      }
    }, React.createElement('div', {
      style: {
        padding: '13px 15px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 9
      }
    }, React.createElement(Avatar, {
      name: r.name,
      kind: 'agent',
      size: 26
    }), React.createElement('div', null, React.createElement('div', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 13.5,
        fontWeight: 600,
        color: 'var(--foreground)'
      }
    }, r.name), React.createElement('div', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--muted-foreground)'
      }
    }, r.model + ' · grounded in source'))), React.createElement('div', {
      style: {
        padding: '12px 15px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12
      }
    }, r.points.map((p, i) => React.createElement('div', {
      key: i,
      style: {
        display: 'flex',
        gap: 9,
        alignItems: 'flex-start'
      }
    }, React.createElement('span', {
      style: {
        marginTop: 3,
        flex: 'none'
      }
    }, React.createElement(StatusDot, {
      status: p.kind === 'agree' ? 'agree' : 'diverge',
      size: 8
    })), React.createElement('span', {
      style: {
        flex: 1,
        fontFamily: 'var(--font-sans)',
        fontSize: 12.5,
        lineHeight: 1.4,
        color: 'var(--foreground)'
      }
    }, p.text), p.kind === 'diverge' ? React.createElement('button', {
      onClick: () => onAccept(p.text),
      style: {
        flex: 'none',
        appearance: 'none',
        border: '1px solid var(--border)',
        background: 'var(--background)',
        borderRadius: 'var(--radius-sm)',
        padding: '2px 9px',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--foreground)',
        cursor: 'pointer'
      }
    }, 'accept') : null))));
  }
  function Review() {
    const [accepted, setAccepted] = React.useState([]);
    const accept = t => setAccepted(a => a.includes(t) ? a : [...a, t]);
    return React.createElement('div', {
      style: {
        height: '100%',
        overflowY: 'auto',
        padding: '22px 24px'
      }
    }, React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 8
      }
    }, React.createElement('h2', {
      style: {
        margin: 0,
        fontFamily: 'var(--font-sans)',
        fontSize: 22,
        fontWeight: 600,
        letterSpacing: '-0.02em',
        color: 'var(--foreground)'
      }
    }, 'Review panel'), React.createElement(Badge, {
      variant: 'outline'
    }, 'SPEC-014 · in-review')), React.createElement('p', {
      style: {
        margin: '0 0 20px',
        maxWidth: 640,
        fontFamily: 'var(--font-sans)',
        fontSize: 13.5,
        lineHeight: 1.55,
        color: 'var(--muted-foreground)'
      }
    }, 'The same specification is critiqued independently by agents on different models, each grounded in the source. Different models have different blind spots — agreement and divergence are surfaced, and accepted points feed back into the draft.'), React.createElement('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 16,
        marginBottom: 18
      }
    }, REVIEWERS.map(r => React.createElement(ReviewerCard, {
      key: r.name,
      r,
      onAccept: accept
    }))), React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        background: 'var(--secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-xl)',
        padding: '14px 18px'
      }
    }, React.createElement('span', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--foreground)'
      }
    }, 'Human adjudicates'), React.createElement('span', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        color: 'var(--muted-foreground)'
      }
    }, accepted.length ? accepted.length + ' point' + (accepted.length > 1 ? 's' : '') + ' accepted — fed back to authoring' : 'accept · dismiss · send a section back for revision'), React.createElement('div', {
      style: {
        flex: 1
      }
    }), React.createElement(Button, {
      variant: 'outline',
      size: 'sm'
    }, 'Send back'), React.createElement(Button, {
      size: 'sm'
    }, 'Finalise & approve')));
  }
  window.SO_Review = Review;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orchestrator/Review.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orchestrator/Session.jsx
try { (() => {
// SpecOne UI kit — Session detail: todos, transcript, diff + permission gate.
(function () {
  const Icon = window.SO_Icon;
  const NS = window.SpecOneDesignSystem_b87656;
  const {
    Button,
    Badge,
    StatusDot
  } = NS;
  const TODOS = [{
    t: 'Read retry handler & payments schema',
    s: 'done'
  }, {
    t: 'Add idempotency_key column + unique index',
    s: 'done'
  }, {
    t: 'Guard handler on the key',
    s: 'running'
  }, {
    t: 'Write WHEN/THEN test for repeat event',
    s: 'idle'
  }];
  const DIFF = [{
    type: 'meta',
    text: 'src/payments/retry.ts'
  }, {
    type: 'ctx',
    text: '  async function retry(event: WebhookEvent) {'
  }, {
    type: 'add',
    text: '    const key = event.idempotencyKey;'
  }, {
    type: 'add',
    text: '    if (await seen(key)) return existing(key);'
  }, {
    type: 'ctx',
    text: '    const result = await charge(event);'
  }, {
    type: 'del',
    text: '    return result;'
  }, {
    type: 'add',
    text: '    await record(key, result);'
  }, {
    type: 'add',
    text: '    return result;'
  }, {
    type: 'ctx',
    text: '  }'
  }];
  function PermissionGate({
    onResolve
  }) {
    return React.createElement('div', {
      style: {
        position: 'absolute',
        inset: 0,
        background: 'rgba(10,10,10,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20
      }
    }, React.createElement('div', {
      style: {
        width: 460,
        background: 'var(--card)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-lg)',
        overflow: 'hidden',
        border: '1px solid var(--border)'
      }
    }, React.createElement('div', {
      style: {
        padding: '16px 20px',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        borderBottom: '1px solid var(--border)'
      }
    }, React.createElement('span', {
      style: {
        color: 'var(--foreground)',
        display: 'flex'
      }
    }, React.createElement(Icon, {
      name: 'shield',
      size: 20
    })), React.createElement('span', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--foreground)'
      }
    }, 'Permission requested'), React.createElement('div', {
      style: {
        flex: 1
      }
    }), React.createElement(Badge, {
      variant: 'secondary'
    }, 'supervised')), React.createElement('div', {
      style: {
        padding: '18px 20px'
      }
    }, React.createElement('p', {
      style: {
        margin: '0 0 6px',
        fontFamily: 'var(--font-sans)',
        fontSize: 16,
        fontWeight: 600,
        color: 'var(--foreground)'
      }
    }, 'Open a pull request?'), React.createElement('p', {
      style: {
        margin: '0 0 14px',
        fontFamily: 'var(--font-sans)',
        fontSize: 13.5,
        lineHeight: 1.5,
        color: 'var(--muted-foreground)'
      }
    }, 'The Engineering agent wants to run ', React.createElement('code', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        background: 'var(--muted)',
        color: 'var(--foreground)',
        padding: '1px 5px',
        borderRadius: 4
      }
    }, 'gh pr create'), ' on branch ', React.createElement('code', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        background: 'var(--muted)',
        color: 'var(--foreground)',
        padding: '1px 5px',
        borderRadius: 4
      }
    }, 'feat/idempotent-retry'), '. The decision is logged.'), React.createElement('div', {
      style: {
        display: 'flex',
        gap: 10,
        justifyContent: 'flex-end'
      }
    }, React.createElement(Button, {
      variant: 'outline',
      size: 'sm',
      onClick: () => onResolve('deny')
    }, 'Deny'), React.createElement(Button, {
      size: 'sm',
      onClick: () => onResolve('approve')
    }, 'Approve')))));
  }
  function Session({
    task,
    onBack
  }) {
    const [gate, setGate] = React.useState(false);
    const [resolved, setResolved] = React.useState(null);
    const t = task || {
      taskId: 'T-4',
      title: 'Guard the retry handler',
      harness: 'Claude Code',
      model: 'Sonnet'
    };
    return React.createElement('div', {
      style: {
        position: 'relative',
        height: '100%',
        display: 'flex',
        minHeight: 0
      }
    }, gate ? React.createElement(PermissionGate, {
      onResolve: r => {
        setGate(false);
        setResolved(r);
      }
    }) : null, React.createElement('div', {
      style: {
        width: 340,
        flex: 'none',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--background)'
      }
    }, React.createElement('div', {
      style: {
        padding: '14px 18px',
        borderBottom: '1px solid var(--border)'
      }
    }, React.createElement('button', {
      onClick: onBack,
      style: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        color: 'var(--muted-foreground)',
        padding: 0,
        marginBottom: 10
      }
    }, React.createElement('span', {
      style: {
        transform: 'rotate(180deg)',
        display: 'flex'
      }
    }, React.createElement(Icon, {
      name: 'chevron',
      size: 14
    })), 'board'), React.createElement('div', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--muted-foreground)'
      }
    }, t.taskId), React.createElement('div', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 15,
        fontWeight: 600,
        color: 'var(--foreground)',
        marginTop: 3
      }
    }, t.title), React.createElement('div', {
      style: {
        display: 'flex',
        gap: 6,
        marginTop: 8
      }
    }, React.createElement('span', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--foreground)',
        background: 'var(--secondary)',
        padding: '2px 6px',
        borderRadius: 4
      }
    }, t.harness), React.createElement('span', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--muted-foreground)'
      }
    }, t.model))), React.createElement('div', {
      style: {
        padding: '14px 18px',
        flex: 1,
        overflowY: 'auto'
      }
    }, React.createElement('div', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: 'var(--muted-foreground)',
        fontWeight: 500,
        marginBottom: 12
      }
    }, 'Session todos'), TODOS.map((td, i) => React.createElement('div', {
      key: i,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 0',
        borderBottom: '1px solid var(--line-soft)'
      }
    }, React.createElement(StatusDot, {
      status: td.s === 'done' ? 'done' : td.s,
      pulse: td.s === 'running',
      size: 8
    }), React.createElement('span', {
      style: {
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        color: td.s === 'idle' ? 'var(--neutral-400)' : 'var(--foreground)'
      }
    }, td.t))))), React.createElement('div', {
      style: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--background)'
      }
    }, React.createElement('div', {
      style: {
        height: 52,
        flex: 'none',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 18px',
        gap: 10
      }
    }, React.createElement('span', {
      style: {
        color: 'var(--muted-foreground)',
        display: 'flex'
      }
    }, React.createElement(Icon, {
      name: 'file',
      size: 16
    })), React.createElement('span', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--foreground)'
      }
    }, 'session diff'), resolved ? React.createElement(Badge, {
      variant: resolved === 'approve' ? 'default' : 'destructive'
    }, resolved === 'approve' ? 'pr approved' : 'denied') : null, React.createElement('div', {
      style: {
        flex: 1
      }
    }), React.createElement(Button, {
      variant: 'outline',
      size: 'sm'
    }, 'Revert run'), React.createElement(Button, {
      size: 'sm',
      iconLeft: React.createElement(Icon, {
        name: 'pr',
        size: 14
      }),
      onClick: () => setGate(true)
    }, 'Open pull request')), React.createElement('div', {
      style: {
        flex: 1,
        overflowY: 'auto',
        padding: '16px 18px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12.5,
        lineHeight: 1.7
      }
    }, DIFF.map((l, i) => {
      const map = {
        meta: {
          color: 'var(--muted-foreground)',
          bg: 'transparent',
          pre: ''
        },
        ctx: {
          color: 'var(--foreground)',
          bg: 'transparent',
          pre: '\u00A0\u00A0'
        },
        add: {
          color: 'var(--success)',
          bg: 'var(--success-bg)',
          pre: '+ '
        },
        del: {
          color: 'var(--destructive)',
          bg: 'var(--danger-bg)',
          pre: '\u2212 '
        }
      }[l.type];
      return React.createElement('div', {
        key: i,
        style: {
          background: map.bg,
          color: map.color,
          padding: '1px 8px',
          borderRadius: 4,
          whiteSpace: 'pre',
          fontWeight: l.type === 'meta' ? 600 : 400
        }
      }, map.pre + l.text);
    }))));
  }
  window.SO_Session = Session;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orchestrator/Session.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orchestrator/Shell.jsx
try { (() => {
// SpecOne UI kit — app shell: light monochrome sidebar + top bar (shadcn).
(function () {
  const Icon = window.SO_Icon;
  function Wordmark({
    size = 18,
    onDark = false
  }) {
    return React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 4,
        fontFamily: 'var(--font-sans)',
        fontWeight: 600,
        fontSize: size,
        letterSpacing: '-0.02em',
        color: onDark ? '#FAFAFA' : 'var(--foreground)'
      }
    }, React.createElement('span', {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: size * 0.66,
        fontWeight: 500,
        color: onDark ? '#A1A1A1' : 'var(--muted-foreground)'
      }
    }, '//'), 'SpecOne');
  }
  function RailButton({
    name,
    label,
    active,
    onClick
  }) {
    const [hover, setHover] = React.useState(false);
    return React.createElement('button', {
      onClick,
      title: label,
      'aria-label': label,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        width: 40,
        height: 40,
        borderRadius: 'var(--radius-md)',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? 'var(--accent)' : hover ? 'var(--accent)' : 'transparent',
        color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
        transition: 'var(--transition-control)'
      }
    }, React.createElement(Icon, {
      name,
      size: 19
    }));
  }
  function IconRail({
    active,
    onNav
  }) {
    const items = [{
      id: 'library',
      name: 'book',
      label: 'Specifications'
    }, {
      id: 'cockpit',
      name: 'chat',
      label: 'Authoring cockpit'
    }, {
      id: 'review',
      name: 'users',
      label: 'Review panel'
    }, {
      id: 'board',
      name: 'board',
      label: 'Delivery board'
    }, {
      id: 'audit',
      name: 'history',
      label: 'Audit & activity'
    }];
    return React.createElement('div', {
      style: {
        width: 60,
        background: 'var(--background)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '14px 0',
        gap: 4,
        flex: 'none'
      }
    }, React.createElement('div', {
      style: {
        width: 40,
        height: 40,
        borderRadius: 'var(--radius-md)',
        background: 'var(--primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 12,
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--primary-foreground)'
      }
    }, '//'), items.map(it => React.createElement(RailButton, {
      key: it.id,
      ...it,
      active: active === it.id,
      onClick: () => onNav(it.id)
    })), React.createElement('div', {
      style: {
        flex: 1
      }
    }), React.createElement(RailButton, {
      name: 'settings',
      label: 'Settings',
      active: active === 'settings',
      onClick: () => onNav('settings')
    }), React.createElement('div', {
      style: {
        width: 30,
        height: 30,
        borderRadius: '999px',
        background: 'var(--secondary)',
        color: 'var(--foreground)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 600,
        marginTop: 8
      }
    }, 'PN'));
  }
  function TopBar({
    crumbs = [],
    children
  }) {
    return React.createElement('div', {
      style: {
        height: 56,
        flex: 'none',
        background: 'var(--background)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        gap: 12
      }
    }, React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0
      }
    }, crumbs.map((c, i) => React.createElement(React.Fragment, {
      key: i
    }, i > 0 ? React.createElement('span', {
      style: {
        color: 'var(--neutral-400)',
        display: 'flex'
      }
    }, React.createElement(Icon, {
      name: 'chevron',
      size: 14
    })) : null, React.createElement('span', {
      style: {
        fontFamily: i === crumbs.length - 1 ? 'var(--font-sans)' : 'var(--font-mono)',
        fontSize: i === crumbs.length - 1 ? 15 : 12,
        fontWeight: i === crumbs.length - 1 ? 600 : 400,
        letterSpacing: i === crumbs.length - 1 ? '-0.01em' : '0',
        color: i === crumbs.length - 1 ? 'var(--foreground)' : 'var(--muted-foreground)',
        whiteSpace: 'nowrap'
      }
    }, c)))), React.createElement('div', {
      style: {
        flex: 1
      }
    }), children);
  }
  function AppShell({
    active,
    onNav,
    topbar,
    children
  }) {
    return React.createElement('div', {
      style: {
        display: 'flex',
        height: '100%',
        width: '100%',
        background: 'var(--background)',
        overflow: 'hidden'
      }
    }, React.createElement(IconRail, {
      active,
      onNav
    }), React.createElement('div', {
      style: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0
      }
    }, topbar, React.createElement('div', {
      style: {
        flex: 1,
        minHeight: 0,
        overflow: 'hidden'
      }
    }, children)));
  }
  Object.assign(window, {
    SO_AppShell: AppShell,
    SO_TopBar: TopBar,
    SO_Wordmark: Wordmark
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orchestrator/Shell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/orchestrator/icons.jsx
try { (() => {
// SpecOne UI kit — Lucide-style line icons (1.75px stroke, currentColor).
// Substitution flag: Lucide is the inferred set for the shadcn/Radix stack.
(function () {
  const P = {
    file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
    board: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M14 14h7v7h-7z', 'M3 14h7v7H3z'],
    pr: ['M6 3v12', 'M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M15 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9v3a2 2 0 0 1-2 2H9'],
    branch: ['M6 3v12', 'M18 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 6v2a2 2 0 0 1-2 2H8'],
    check: ['M20 6 9 17l-5-5'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'],
    search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
    plus: ['M12 5v14', 'M5 12h14'],
    chevron: ['m9 18 6-6-6-6'],
    play: ['M6 3l14 9-14 9z'],
    alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
    users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
    bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
    server: ['M2 3h20v6H2z', 'M2 15h20v6H2z', 'M6 6h.01', 'M6 18h.01'],
    shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
    eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
    bot: ['M12 8V4H8', 'M4 8h16v12H4z', 'M2 14h2', 'M20 14h2', 'M9 13v2', 'M15 13v2'],
    sparkle: ['M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z'],
    layers: ['m12 2 9 5-9 5-9-5z', 'm3 12 9 5 9-5', 'm3 17 9 5 9-5'],
    dot: ['M12 12h.01'],
    book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
    history: ['M3 3v5h5', 'M3.05 13A9 9 0 1 0 6 5.3L3 8', 'M12 7v5l4 2']
  };
  function Icon({
    name,
    size = 18,
    stroke = 1.75,
    style
  }) {
    const paths = P[name] || P.dot;
    return React.createElement('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: stroke,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style
    }, paths.map((d, i) => React.createElement('path', {
      key: i,
      d
    })));
  }
  window.SO_Icon = Icon;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/orchestrator/icons.jsx", error: String((e && e.message) || e) }); }

__ds_ns.AgentMessage = __ds_scope.AgentMessage;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Callout = __ds_scope.Callout;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.KanbanCard = __ds_scope.KanbanCard;

__ds_ns.SpecCard = __ds_scope.SpecCard;

__ds_ns.StatusDot = __ds_scope.StatusDot;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Textarea = __ds_scope.Textarea;

})();
