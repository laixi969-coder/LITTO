// LITTO does not collect usage data. The LITTO telemetry collector was removed on purpose;
// this module keeps the original surface as no-ops so that call sites stay unchanged.
type UsageEvent = "onboarding.complete" | "onboarding.skip" | "workspace.canvas" | "workspace.document";
type AgentOutcome = "success" | "failed" | "cancelled";
type CanvasSnapshot = { nodes: readonly { type?: string }[]; edgeCount: number };

const anonymousData = {
  track(_event: UsageEvent) {},
  startAgent(): (outcome: AgentOutcome) => void {
    return () => {};
  },
  observeCanvas(_read: () => CanvasSnapshot | undefined) {
    return () => {};
  },
};
export default anonymousData;

export function registerAnonymousData() {
  return () => {};
}
