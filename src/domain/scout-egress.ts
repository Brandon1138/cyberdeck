export interface ScoutEgressGrant {
  root: string;
  provider: "cursor";
  profile: "scout";
  access: "read-only";
  authority: "operator";
  grantedAt: string;
}

export interface ScoutEgressStatus {
  root: string;
  enabled: boolean;
  grant?: ScoutEgressGrant;
}
