import { handleTeamsRequest } from "@/lib/teams/bot";

// Microsoft Teams (via Azure Bot Service) and Microsoft 365 Agents Playground send bot activities here.
// Auth is checked inside the Teams SDK: a Microsoft-signed token is required unless local Playground mode is on.
export const POST = (req: Request) => handleTeamsRequest(req);
