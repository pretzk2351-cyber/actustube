import { redirect } from "next/navigation";

import { auth } from "../../../auth";
import { AppShell } from "@/app/components/app-shell";
import { AppWorkspaceProvider } from "@/app/components/app-workspace-provider";

export default async function AuthenticatedAppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <AppWorkspaceProvider
      user={{
        name: session.user.name?.trim() || "ユーザー",
        email: session.user.email?.trim() || "メールアドレス未取得",
        image: session.user.image ?? null,
      }}
    >
      <AppShell>{children}</AppShell>
    </AppWorkspaceProvider>
  );
}
