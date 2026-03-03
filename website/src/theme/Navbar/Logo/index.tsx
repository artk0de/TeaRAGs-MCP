import React from "react";
import Logo from "@theme/Logo";
import { useWindowSize } from "@docusaurus/theme-common";
import DinoTooltip from "@site/src/components/DinoTooltip";

export default function NavbarLogo() {
  const windowSize = useWindowSize();

  const logo = (
    <Logo
      className="navbar__brand"
      imageClassName="navbar__logo"
      titleClassName="navbar__title text--truncate"
    />
  );

  // On mobile, DinoTooltip's wrapper div overlaps the hamburger toggle,
  // intercepting touch events and preventing the sidebar from opening.
  if (windowSize === "mobile") {
    return logo;
  }

  return (
    <DinoTooltip>
      <div>{logo}</div>
    </DinoTooltip>
  );
}
