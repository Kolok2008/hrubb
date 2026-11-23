# Desktop build (Windows)
```
cd .. && npm install --legacy-peer-deps && npx vite build
cd desktop && rm -rf game && cp -r ../dist game
npm install && npm run pack-win     # -> out/Mushroom Hollow-win32-x64/Mushroom Hollow.exe
```
F11 toggles fullscreen. The "Quit Game" button appears only in the desktop version.
