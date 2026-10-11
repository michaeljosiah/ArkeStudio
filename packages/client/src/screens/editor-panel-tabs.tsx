export function EditorPanelTabs({ value, onChange }: { value: "inspector" | "arke"; onChange: (value: "inspector" | "arke") => void }) {
  return <div className="fx-panel-tabs" role="tablist" aria-label="Editor panel">
    {(["inspector", "arke"] as const).map(tab => <button type="button" key={tab} id={`cut-${tab}-tab`} role="tab"
      aria-controls={`cut-${tab}-panel`} aria-selected={value === tab} tabIndex={value === tab ? 0 : -1}
      onClick={() => onChange(tab)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "inspector" : event.key === "End" ? "arke" : tab === "arke" ? "inspector" : "arke";
        onChange(next); document.getElementById(`cut-${next}-tab`)?.focus();
      }}>{tab === "inspector" ? "Inspector" : "Arke"}</button>)}
  </div>;
}
