import { redirect } from "react-router";

/** Het oude adres van de productlijst: die staat nu op `/`. Een oude link of bladwijzer werkt zo nog. */
export function loader() {
  throw redirect("/", 301);
}
