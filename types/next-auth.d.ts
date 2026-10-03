import type { DefaultSession } from "next-auth";

type Role = "admin" | "va" | "designer" | "helper";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      /** Helpers only: the designer whose board they work. Null for everyone else. */
      helperFor?: string | null;
      /** Epoch ms of this session's sign-in; 0 for sessions minted before it was recorded. */
      signedInAt?: number;
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
    helperFor?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: Role;
    helperFor?: string | null;
    signedInAt?: number;
  }
}
