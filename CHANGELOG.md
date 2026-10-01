# Changelog

## [0.6.0](https://github.com/grafana/cloud-setup/compare/v0.5.0...v0.6.0) (2026-10-01)


### Features

* show sane defaults after picking a Frontend Observability app ([#87](https://github.com/grafana/cloud-setup/issues/87)) ([bfc16f6](https://github.com/grafana/cloud-setup/commit/bfc16f67fbc6d7a651c9cc51c7d86d05b5bdf4a0))

## [0.5.0](https://github.com/grafana/cloud-setup/compare/v0.4.0...v0.5.0) (2026-09-29)


### Features

* Add setup feedback link to final summaries ([#84](https://github.com/grafana/cloud-setup/issues/84)) ([ea875d7](https://github.com/grafana/cloud-setup/commit/ea875d7e81f448d988c48bba8011173980785125))


### Bug Fixes

* Always show the app picker and hide sampling/replay until answered ([#81](https://github.com/grafana/cloud-setup/issues/81)) ([00cecea](https://github.com/grafana/cloud-setup/commit/00cecea0a6913a714674b208a718b10640828b0f))
* list dir empty placeholder ([#83](https://github.com/grafana/cloud-setup/issues/83)) ([4bbd5c1](https://github.com/grafana/cloud-setup/commit/4bbd5c18ca2715fcbae95ba62728a9cdfc8b0f5e))
* Serialize generated strings and validate collector URLs ([#73](https://github.com/grafana/cloud-setup/issues/73)) ([969c013](https://github.com/grafana/cloud-setup/commit/969c013e83341aa2cb0fc71ea176acba3be3e045))
* Update feedback link copy to encourage sharing feedback ([#86](https://github.com/grafana/cloud-setup/issues/86)) ([0baee44](https://github.com/grafana/cloud-setup/commit/0baee444ef4f67cd374f885ff41c35e0c9706ae7))
* Update Session Replay status from beta to public preview ([#85](https://github.com/grafana/cloud-setup/issues/85)) ([be9b800](https://github.com/grafana/cloud-setup/commit/be9b800f7fd5507cbc614d4b151400d22c9cbaeb))

## [0.4.0](https://github.com/grafana/cloud-setup/compare/v0.3.0...v0.4.0) (2026-09-28)


### Features

* Select synthetic probes by stack region ([#71](https://github.com/grafana/cloud-setup/issues/71)) ([3a375fd](https://github.com/grafana/cloud-setup/commit/3a375fd92a1f75494495072554be6f6dcd33b17c))


### Bug Fixes

* Drop the standalone SSL check, cover certs via the Uptime check's alert ([#77](https://github.com/grafana/cloud-setup/issues/77)) ([e9bfce3](https://github.com/grafana/cloud-setup/commit/e9bfce3a7b5f9223ef6117e6a43af73dba383d4c))
* Explain permission failures during synthetics setup ([#70](https://github.com/grafana/cloud-setup/issues/70)) ([448f3f7](https://github.com/grafana/cloud-setup/commit/448f3f7e352ea20c40e7d481fe083c2c3b656978))
* Improve Terraform export's import script and README ([#75](https://github.com/grafana/cloud-setup/issues/75)) ([c3518f6](https://github.com/grafana/cloud-setup/commit/c3518f6a315b78291bc8a4b1dd1531aa0c03c47b))
* readme improvements ([#76](https://github.com/grafana/cloud-setup/issues/76)) ([04d1927](https://github.com/grafana/cloud-setup/commit/04d19270ed34766d0024fc053771aea3491297ed))
* Show retry guidance after gcx installation fails ([#74](https://github.com/grafana/cloud-setup/issues/74)) ([7f73626](https://github.com/grafana/cloud-setup/commit/7f73626d03ce5f9bdf409ddf54a964ab6172afe9))

## [0.3.0](https://github.com/grafana/cloud-setup/compare/v0.2.0...v0.3.0) (2026-09-25)


### Features

* Prompt for setup URLs and support stack slugs ([#59](https://github.com/grafana/cloud-setup/issues/59)) ([dd95b11](https://github.com/grafana/cloud-setup/commit/dd95b1157d297ccf583066d8152c012a85a5e7cb))


### Bug Fixes

* Align wizard outcomes, summaries, and exit codes ([#66](https://github.com/grafana/cloud-setup/issues/66)) ([7d69d89](https://github.com/grafana/cloud-setup/commit/7d69d89fbbdb0979d079c58799c0e79b042950be))
* Flush telemetry before exiting after wizard failures ([#69](https://github.com/grafana/cloud-setup/issues/69)) ([8b98d73](https://github.com/grafana/cloud-setup/commit/8b98d73796460afd28bbb8532c7a578611b11d8b))
* many ux improvements ([#68](https://github.com/grafana/cloud-setup/issues/68)) ([9babadb](https://github.com/grafana/cloud-setup/commit/9babadb38f3c6653ff14148182e50449f8606880))
* Preserve application code when refreshing Faro snippets ([#60](https://github.com/grafana/cloud-setup/issues/60)) ([69378e4](https://github.com/grafana/cloud-setup/commit/69378e4fe268918a63646f6d6776adfd6b2c2e29))
* remove the Browser check candidate ([#67](https://github.com/grafana/cloud-setup/issues/67)) ([5a2276c](https://github.com/grafana/cloud-setup/commit/5a2276cedd8acafe2978b19afffb4dc7a852f88f))

## [0.2.0](https://github.com/grafana/cloud-setup/compare/v0.1.1...v0.2.0) (2026-09-23)


### Features

* Add an alerting step to the synthetics wizard ([#36](https://github.com/grafana/cloud-setup/issues/36)) ([7ec33d8](https://github.com/grafana/cloud-setup/commit/7ec33d8be47946bba6f406ba6e341c107e83d119))


### Bug Fixes

* **deps:** update dependency zod to v4 ([#11](https://github.com/grafana/cloud-setup/issues/11)) ([495ee58](https://github.com/grafana/cloud-setup/commit/495ee58a4eacf22c19e8e216d2434dacb2855387))
* Make the UI legible on light terminals and without color ([#43](https://github.com/grafana/cloud-setup/issues/43)) ([8d12d83](https://github.com/grafana/cloud-setup/commit/8d12d83b6c56b4828ad6ee011375df30a0401cb0))
