import { redirect } from "next/navigation";

export default async function PackPage({ params }: { params: Promise<{ pack: string }> }) {
  const { pack } = await params;
  redirect(`/studio/${pack}/luoghi`);
}
