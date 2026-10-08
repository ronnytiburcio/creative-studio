import { redirect } from "next/navigation";

export default async function ChannelIndex(props: PageProps<"/fkbpros/[channel]">) {
  const { channel } = await props.params;
  redirect(`/fkbpros/${encodeURIComponent(channel)}/library`);
}
