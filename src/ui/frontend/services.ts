import { tryFaroClient, type FaroClient } from "../../products/frontendO11y/faroAuth.js";
import {
  detectEnvironmentExpr,
  detectFrontendTarget,
  insertFaroSnippet,
  installFaroPackages,
  openFrontendO11ySetupPage,
  readPkgName,
  readPkgVersion,
} from "../../products/frontendO11y/instrument.js";
import { instrumentNextjs } from "../../products/frontendO11y/nextjs.js";
import { instrumentReact } from "../../products/frontendO11y/react.js";
import { commonServices } from "../workflow/services.js";

export const frontendServices = {
  ...commonServices,
  tryFaroClient: tryFaroClient as (
    url: string,
  ) => Promise<Pick<FaroClient, "list" | "findExisting" | "create"> | undefined>,
  detectEnvironmentExpr,
  detectFrontendTarget,
  insertFaroSnippet,
  installFaroPackages,
  openFrontendO11ySetupPage,
  readPkgName,
  readPkgVersion,
  instrumentNextjs,
  instrumentReact,
};
export type FrontendServices = typeof frontendServices;
