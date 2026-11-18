# Mi pauta

Copia digital de una pauta de alimentación entregada al alta, baja en sal, para leerla
cómoda en el teléfono: letra grande, alto contraste y lectura en voz alta.

- La pauta se reproduce **textual**, tal como la escribió la nutricionista. La página no
  agrega cifras, límites ni recomendaciones propias.
- Las anotaciones personales (por ejemplo controles o diario) se guardan **solo en el
  teléfono**, en el navegador. No hay servidor, cuentas ni envío de datos. Si se borran
  los datos del navegador, se pierden.
- **No reemplaza al equipo de salud.** Ante cualquier duda, síntoma o cambio, se consulta
  al equipo tratante.

## Instalar en el teléfono

Abrir la dirección de la página (`https://<usuario>.github.io/mi-pauta/`) con internet.

**Android (Chrome):** tocar el menú ⋮ y elegir «Instalar aplicación» o «Agregar a la
pantalla principal». Queda un ícono como cualquier otra app.

**iPhone (Safari):** tocar el botón Compartir (cuadrado con flecha hacia arriba) y elegir
«Agregar a inicio». Tiene que ser desde Safari.

Después de abrirla una vez con internet, funciona sin conexión.

## Actualizar la pauta

Solo cuando el equipo de salud entregue una pauta nueva. Hay que cambiar **tres cosas en
el mismo commit**:

1. `pauta-personal/index.html`: el texto nuevo, copiado tal cual.
2. `tests/pauta-personal/check_verbatim.py`: la lista `SOURCE` con las mismas frases, para
   que el chequeo confirme que la página dice exactamente eso.
3. `pauta-personal/sw.js`: subir `VERSION` (por ejemplo `pauta-v2` → `pauta-v3`), para que
   los teléfonos descarguen la versión nueva. También se sube si cambia cualquier otro
   archivo de `pauta-personal/`.

Al hacer push a `main`, GitHub Actions corre los chequeos y, si pasan, publica la página.
Los teléfonos toman la versión nueva la próxima vez que la abran con internet.

Para revisar antes de subir:

```sh
python3 -I tests/pauta-personal/check_verbatim.py pauta-personal/index.html
python3 -I tools/guardia_sensible.py --excluir .git .
```

## Qué hay aquí

- `pauta-personal/`: la página que se publica.
- `tests/pauta-personal/`: chequeos de la página.
- `tools/guardia_sensible.py`: revisa que no se publiquen correos, teléfonos, números de
  identidad, binarios ni metadatos de imágenes.
- `.github/workflows/pages.yml`: chequeos y publicación en GitHub Pages.
