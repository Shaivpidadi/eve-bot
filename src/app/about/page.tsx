import { ABOUT } from "../../site/content";
import { TextPageView, textPageMetadata } from "../../site/page";

export const metadata = textPageMetadata("/about", ABOUT, "What EVE BOT is, how HQ and the Bots work, and where it runs.");

export default function Page() {
  return <TextPageView page={ABOUT} />;
}
