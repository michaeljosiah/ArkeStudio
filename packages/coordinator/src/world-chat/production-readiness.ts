import { deriveProductionReadiness, type WorldBundle, type ProductionPlanRequest, type ProductionPlanCard,
  type WorldChatContext, type WorldChatCheckReceipt, type ReadinessExport, type WorldChatWorkspace } from "@arke-studio/contracts";
import { productionReadinessFence } from "./target-reads.js";

export function validateProductionPlan(bundle: WorldBundle, exports: readonly ReadinessExport[], request: ProductionPlanRequest,
  entryContext: WorldChatContext | undefined, receipts: readonly WorldChatCheckReceipt[]): void {
  const productionId = entryContext && "productionId" in entryContext ? entryContext.productionId : undefined;
  const production = bundle.productions.find(p => p.meta.id === request.productionId);
  if (!production || productionId !== request.productionId) throw new Error("The plan must name this thread's production.");
  const fence = productionReadinessFence(deriveProductionReadiness(bundle, production, exports));
  if (!receipts.some(r => request.checkReceiptIds.includes(r.id) && r.tool === "target-read" && r.status === "complete" &&
    r.target?.requirement === "readiness" && r.target.id === request.productionId && r.complete === true && r.nextCursor === null &&
    r.observedRevisionOrDigest === fence)) throw new Error("Read fresh complete readiness before proposing a plan.");
}

export function projectProductionPlan(bundle: WorldBundle, exports: readonly ReadinessExport[], request: Pick<ProductionPlanRequest,"productionId" | "nextSteps">): ProductionPlanCard {
  const production = bundle.productions.find(p => p.meta.id === request.productionId);
  const readiness = production ? deriveProductionReadiness(bundle, production, exports) : null;
  return { kind: "production-plan", worldId: bundle.meta.worldId, productionId: request.productionId, nextSteps: request.nextSteps,
    exports: readiness?.lastExport ? [readiness.lastExport] : [], readiness };
}

export function refreshProductionPlanCards(workspace: WorldChatWorkspace, bundle: WorldBundle, exports: readonly ReadinessExport[]): WorldChatWorkspace {
  return {...workspace,messages:workspace.messages.map(message => message.productionPlan?.worldId === bundle.meta.worldId
    ? {...message,productionPlan:projectProductionPlan(bundle,exports,message.productionPlan)} : message)};
}
