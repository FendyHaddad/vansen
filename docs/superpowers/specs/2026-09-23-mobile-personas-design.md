# Personas on mobile — design

Date: 2026-09-23. Sub-project 2 of 4 in mobile parity (1 server-driven catalog is
live: `bd6e3bc`, mobile `52ed3bc`). Decisions taken by Claude under the owner's
standing go-ahead of 2026-09-23; the owner can redirect any of them.

Backend feature being mirrored: `specs/2026-09-23-persona-references-design.md`
(five guided photos, consent, Studio 2 / Pro 5 slots, hidden `persona` family on
Nano Banana Pro 4K, 46 credits per image). Web client:
`src/app/features/workspace/persona-manager/*`, `persona-picker/*`,
`core/.../persona-store.ts`, `photo-prep.ts`.

## 1. Principle carried over

The server defines every persona rule; the app renders it. Today several rules
live only in code the phone cannot read — slot order, slot labels, minimum
short edge (1024 px, defined twice), byte cap (2.5 MB, app.ts only), slots per
plan (TS `PERSONA_SLOTS` and SQL `dispatch_limits`), allowed aspect ratios
(Nano Banana's). They move into `/catalog`, so a change to any of them is a
backend deploy, never an app release.

## 2. Backend: extend `flat.persona` in `buildCatalog()`

```jsonc
"persona": {
  "creditsPerImage": 46,
  "enabled": false,                       // models.enabled for 'persona'
  "photoSlots": [                         // PERSONA_SLOT_ORDER, render order
    { "id": "front", "label": "Front" },
    { "id": "left_three_quarter", "label": "Left ¾" },
    { "id": "right_three_quarter", "label": "Right ¾" },
    { "id": "left_profile", "label": "Left profile" },
    { "id": "right_profile", "label": "Right profile" }
  ],
  "minEdge": 1024,
  "maxBytes": 2621440,
  "maxNameLength": 40,
  "planSlots": { "studio": 2, "pro": 5, "owner": 5 },
  "aspectRatios": ["1:1", "3:4", "4:3", "16:9", "9:16"],
  "batch": { "min": 1, "max": 4 }
}
```

- Every value comes from the constant the gateway already enforces: one shared
  `PERSONA_MIN_EDGE` (the gateway's `personas.ts` and the web's `photo-prep.ts`
  import it instead of defining 1024 twice), `PERSONA_MAX_BYTES` moved from
  `app.ts` to `model-families.ts`, `PERSONA_SLOTS`, the Nano Banana aspect
  ratios the gateway validates persona requests against, `IMAGE_BATCH_MAX`.
- Slot labels move from the web's `persona-manager.ts` into
  `model-families.ts` (`PERSONA_SLOT_LABELS`); the web reads them from there.
- A guard test asserts `planSlots` equals the SQL `dispatch_limits` seed
  (`persona_slots:*`) so the two stores of the same number cannot drift.
- Additive; the web and the live phone ignore unknown fields.

## 3. Mobile

**Data** (`lib/data/personas/`): `PersonaDto {id, name, status draft|ready,
photos [{slot, url?}], thumbUrl?, createdAt}`, `PersonaSlots {used, max}`,
`PersonaRepo` over `GET /personas`, `POST /personas {name, attested: true}`,
`PUT /personas/:id/photos/:slot {uploadId}`, `DELETE /personas/:id`, and
`POST /uploads` with `purpose=persona-photo` (`ApiClient.postFile` gains an
optional `fields` map). `CatalogFlat.persona` parses the new fields.
`personasProvider` (Riverpod notifier) holds items + slots, loads on first
use, reloads after every mutation.

**Photo prep** (`lib/features/personas/photo_prep.dart`): pick from gallery or
camera (`image_picker`, `maxWidth/maxHeight 2048`, `imageQuality 92`), read
the decoded size, refuse a short edge below `minEdge` before uploading
("Use a sharper photo — at least 1024 px on the short side."), refuse above
`maxBytes`. The server re-checks both.

**Personas screen** (`/personas`, from Settings and from the composer's
persona sheet):
- List of personas with thumb, name, Draft/Ready badge, and "n of max used".
- "New persona": name field (`maxNameLength`) + consent checkbox with the web's
  exact copy ("This is me, or someone who gave me permission to use their
  photos."); Create disabled until both are set.
- Persona detail: the five slots in `photoSlots` order, each showing the photo
  or the guide image (`<webOrigin>/personas/guides/<slot>.jpg`, falling back
  to a bundled silhouette), label, and tap → camera/gallery → prep → upload →
  PUT. Tip copy from the web: "Sharp photos, good light, one person, no
  sunglasses. Tap a slot to add or replace it." Ready copy: "Ready — choose it
  in the composer."
- Delete with a confirm dialog.
- No plan → the screen shows the upgrade prompt (`studio_required`).

**Composer**: a persona chip beside the model chip, shown to entitled users.
Its sheet lists Ready personas plus "Manage personas". With a persona chosen:
the model chip and reference attach are hidden (a persona uses its own
photos), the settings sheet offers only `aspectRatios` and batch, the price is
`creditsPerImage × batch`, and submit sends `personaId` with the request the
gateway expects. When `flat.persona.enabled` is false the chip still shows
but Generate is blocked with "Personas are temporarily unavailable." —
matching the web's `modelDisabledNotice`. Choosing a persona clears any
attached reference; choosing a model clears the persona.

**Errors**: add `slot_limit`, `photo_too_small`, `photo_too_large`,
`photo_unavailable`, `invalid_slot`, `persona_unavailable`,
`persona_photo_failed`, `persona_lookup_failed`, `create_failed`,
`delete_failed` to the `ApiError` map with messages and actions.

**Permissions**: iOS `NSCameraUsageDescription` ("Take persona photos with the
camera."); Android needs no new permission for `image_picker` camera capture.

**Library**: already renders persona items read-only with a badge (phase 1).
Retry/variation stay gated by `/retryable`.

## 4. Testing

- Backend: `flat.persona` values equal the enforcing constants; `planSlots`
  equals the SQL seed; web persona manager still renders the same labels.
- Mobile (TDD): DTO parsing; repo calls and error mapping; photo prep refuses
  small/oversized images; create requires name + consent; slot upload flow
  (upload with purpose, then PUT) updates the tile; delete; composer with a
  persona hides model/reference, prices `creditsPerImage × batch`, sends
  `personaId`; disabled persona blocks Generate with the notice; non-entitled
  users see no chip.
- Gates: `npm run verify`, `ng build`, `flutter analyze --no-pub`,
  `flutter test --no-pub`.

## 5. Rollout

Backend first (`./deploy.sh`, additive), read back `flat.persona`. Mobile
commit (local repo). The persona family stays `enabled = false` until the
owner's live smoke; mobile shows the notice until then.

## 6. Out of scope

Enabling persona in production, the owner's likeness test and guide-photo
generation, store builds.
