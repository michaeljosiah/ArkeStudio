import { Component, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { AppChrome } from "./chrome.js";
import { EmptyState } from "./layout.js";
import { Button } from "./ui.js";

function RouteFailure() {
  const navigate = useNavigate();
  return (
    <div className="fy-app">
      <AppChrome back={{ label: "Worlds", to: "/worlds" }} />
      <div className="fy-content" role="alert">
        <EmptyState title="This screen could not be shown" hint="Something went wrong while displaying this screen."
          action={<Button onClick={() => navigate("/worlds")}>Worlds</Button>} />
      </div>
    </div>
  );
}

class ScreenBoundary extends Component<{ locationKey: string; children: ReactNode }> {
  override state = { failed: false, locationKey: this.props.locationKey };

  static getDerivedStateFromError() { return { failed: true }; }

  static getDerivedStateFromProps(props: { locationKey: string }, state: { locationKey: string }) {
    // Clear a failed screen on navigation without remounting healthy editors on query changes.
    return props.locationKey !== state.locationKey ? { failed: false, locationKey: props.locationKey } : null;
  }

  override render() { return this.state.failed ? <RouteFailure /> : this.props.children; }
}

export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  // Direct hash changes have no router history state and can all carry the key "default".
  const locationKey = JSON.stringify([location.key, location.pathname, location.search, location.hash]);
  return <ScreenBoundary locationKey={locationKey}>{children}</ScreenBoundary>;
}
