# Stream Vehicle

A wind tunnel in the browser, as a page on nassau.se: drop in a 3D model of a car, bike, plane,
airship or anything else, and watch the air flow around it. Smoke lines, the pressure on the body,
a slice through the flow (speed, pressure or swirl), and the drag and lift coefficients, settling
as the run goes on. Render a still or an MP4 of it.

Built on the Voyager app shell (same header, steps, panels, support panel and project storage).
No backend, no accounts: tests live in the browser (IndexedDB) and can be downloaded as
`.stream-vehicle.json` files, which carry the 3D file inside them.

## How it works

- **Solver:** a D3Q19 lattice Boltzmann method with a Smagorinsky turbulence model, running as
  WebGPU compute shaders (`src/lib/sim/`). The inlet blows at the wind speed; the outlet, the
  sides and the top are open (zero gradient), with a weak pull towards atmospheric pressure at the
  outlet and a sponge band of extra viscosity that soaks up pressure waves. The floor is a fixed
  floor, a moving road or absent (free air); under the body the road is held still, because the
  grid can't resolve that gap. The model is a bounce-back wall. Drag, lift and side force come
  from momentum exchange on the model's cells, as gauge pressure against a reference point in the
  free stream, averaged over the settled part of the run.
- **Model:** GLB, glTF, STL, OBJ, PLY and FBX are read with three.js loaders
  (`src/lib/geometry/load.ts`), oriented (up axis, heading), scaled to the real length you give,
  and voxelized in a worker (`voxelize.ts`): every cell a triangle touches is marked, then a flood
  fill from the tunnel's open sides finds the outside, so small gaps in a mesh are sealed.
- **Tunnel size:** about one model length of clear air in front, two and a bit behind, room to
  the sides and above (`src/lib/sim/setup.ts`). The detail setting picks the number of cells
  (0.6 to 6 million); the solver needs about 170 bytes of graphics memory per cell.
- **Drawing:** WebGPU render pipelines read the solver's buffers directly
  (`src/lib/render/`): the model shaded with its surface pressure, smoke particles moved through
  the flow with trails, a slice plane, the floor grid.
- **Built-in shapes:** signed distance functions meshed with marching tetrahedra
  (`src/lib/geometry/examples.ts`, `mesher.ts`): a hatchback, the Ahmed body (the standard car
  aerodynamics test shape), a box truck, a light aircraft, an airship and a sphere.

How far to trust the numbers: the method gets the shape of the flow right (separation, wakes,
where the pressure builds up), but a real vehicle's boundary layer is far thinner than a cell and
wheels don't turn. Checks on very coarse test grids (14–24 cells across the shape, far coarser
than the app's Standard setting): a sphere came out at Cd 0.54 (measured 0.47) and the Ahmed body
at 0.75 (measured about 0.29). Finer grids should get closer, but that is still to be checked on a
real graphics card. Compare versions of a shape at the same
settings rather than reading the numbers as measurements. The moving road needs Fine or Max
detail, so the gap under the vehicle is several cells high.

## 1. Run locally (optional)

    npm install
    npm run dev        # http://localhost:5173

Node 22+. Needs WebGPU: current Chrome or Edge on desktop is the reference; Safari 26 works too.

`tools/` holds the test pages and scripts used during development (not deployed):
`test-sphere.html` checks the solver's drag on a sphere, `make-thumbs.ts` renders the
built-in shapes' silhouettes into `src/assets/shapes/`.

## 2. Deploy as a page under nassau.se (Webflow Cloud)

Plain Vite + React, which Webflow Cloud builds directly (`webflow.json` pins `vite`). Don't set
`base` in `vite.config.ts`; Webflow Cloud sets it from the mount path. Routing is hash based, so
any mount path works.

1. Push this folder to GitHub (contents at the repository root).
2. nassau.se site settings > Webflow Cloud > create a project from the repository, mount path
   `/stream_vehicle`.
3. Publish nassau.se once so the path goes live.
