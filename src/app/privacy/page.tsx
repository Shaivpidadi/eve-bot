import { PRIVACY } from "../../site/content";
import { TextPageView, textPageMetadata } from "../../site/page";

export const metadata = textPageMetadata("/privacy", PRIVACY, "What a deployment of EVE BOT stores, where it lives, and who can see it.");

export default function Page() {
  return <TextPageView page={PRIVACY} />;
}
