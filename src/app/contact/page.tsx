import { CONTACT } from "../../site/content";
import { TextPageView, textPageMetadata } from "../../site/page";

export const metadata = textPageMetadata("/contact", CONTACT, "How to reach the EVE BOT maintainers: the GitHub repository and its issue tracker.");

export default function Page() {
  return <TextPageView page={CONTACT} />;
}
