export type ApprovalHandler = (toolName: string, args: any) => Promise<boolean>;

let currentHandler: ApprovalHandler = async () => {
  // Default fallback: deny by default
  return false;
};

export function setApprovalHandler(handler: ApprovalHandler): void {
  currentHandler = handler;
}

export async function requestApproval(toolName: string, args: any): Promise<boolean> {
  return currentHandler(toolName, args);
}
