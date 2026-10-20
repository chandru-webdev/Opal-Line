// tsx compiles the JSX under src/ with esbuild's *classic* runtime: it only
// honours `jsx: react-jsx` from an auto-detected, non-solution tsconfig, and
// the frontend's tsconfig.json is solution-style (`files: []` + `references`),
// whose JSX setting is ignored. Classic JSX emits `React.createElement(...)`
// lookups, which would throw "React is not defined" at render time — except
// when a global `React` exists. Tests only ever run through this launcher, so
// exposing React globally makes classic-compiled JSX work; files that tsx does
// compile with the automatic runtime are unaffected by this shim.
import React from 'react'

globalThis.React = React
