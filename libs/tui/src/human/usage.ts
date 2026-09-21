export function formatReportedCost(cost: number): string {
  return cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}
