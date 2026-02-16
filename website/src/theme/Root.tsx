import React from "react";
import BrowserOnly from "@docusaurus/BrowserOnly";

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <BrowserOnly>
        {() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const DinoRun = require("@site/src/components/DinoRun").default;
          return <DinoRun />;
        }}
      </BrowserOnly>
    </>
  );
}
