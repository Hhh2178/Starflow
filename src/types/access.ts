export interface AccessibleProject {
  id: number;
  ownerUserId: number | null;
  groupId: number | null;
  [key: string]: unknown;
}
