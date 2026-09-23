import type { DefaultSession } from "next-auth";

type Role = "admin" | "va" | "designer";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      /** Epoch ms of this session's sign-in; 0 for sessions minted before it was recorded. */
      signedInAt?: number;
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: Role;
    signedInAt?: number;
  }
}
