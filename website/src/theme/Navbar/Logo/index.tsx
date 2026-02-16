import React from "react";
import Logo from "@theme/Logo";
import DinoTooltip from "@site/src/components/DinoTooltip";

export default function NavbarLogo() {
  return (
    <DinoTooltip>
      <div>
        <Logo
          className="navbar__brand"
          imageClassName="navbar__logo"
          titleClassName="navbar__title text--truncate"
        />
      </div>
    </DinoTooltip>
  );
}
