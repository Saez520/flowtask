Arquitectura del script
El entrypoint público es pequeño:
.flowtask/scripts/worktree.sh
Ese archivo carga:
.flowtask/scripts/lib/worktree-manager-core.sh
Y el core carga:
.flowtask/scripts/lib/worktree-manager-target-direct.sh
La división actual es:
- worktree.sh: wrapper portable.
- worktree-manager-core.sh: lifecycle normal parent-only, locks, journals, preservación transaccional, cleanup, recover, prune y list.
- worktree-manager-target-direct.sh: lifecycle especial para submodules.
- target-direct-transport.js: serialización, validación y rehidratación segura del descriptor Runner → Constructor.
El diseño evita ejecutar configuraciones como shell: la configuración usa un formato de datos key=value.
Capacidades principales
1. Creación de worktrees
Comando:
.flowtask/scripts/worktree.sh create <work-id> --base <branch>
Por defecto crea:
.worktrees/<work-id>/
worktree/<work-id>
Ejemplo:
worktree.sh create CA-example --base main
Produce:
.worktrees/CA-example/
branch: worktree/CA-example
Validaciones realizadas
Antes de crear recursos verifica:
- Que Git exista.
- Que el repositorio sea válido.
- Que el identificador sea seguro.
- Que la rama base exista.
- Que la rama de trabajo no exista.
- Que la ruta de destino no exista.
- Que la ruta local esté excluida por .gitignore.
- Que la rama y la ruta no estén siendo usadas por otro worktree.
- Que no haya duplicación de identidad entre branch, path y registro Git.
El script no modifica automáticamente .gitignore.
Detección de rama base
Cuando no se especifica explícitamente, usa este orden:
development → main → trunk → main
El último main funciona como fallback documentado.
2. Inicialización opcional de submodules
Por defecto los submodules permanecen sin poblar.
Solo se inicializan si se solicita explícitamente:
worktree.sh create <work-id> --base main --init-submodules
La inicialización es:
- Recursiva.
- Verificada contra los gitlinks registrados.
- Persistida en el journal.
- Reanudable si el proceso se interrumpe.
- Fallida de forma segura si algún submodule no coincide con el SHA esperado.
También puede solicitarse durante complete:
worktree.sh complete <work-id> --base main --init-submodules
3. Preparación y verificación configurables
El gestor permite configurar comandos de preparación y verificación mediante .worktree-manager.conf.
Claves soportadas:
worktrees_dir
branch_prefix
state_dir
prepare_command
prepare_enabled
verify_command
verify_enabled
preserve_dirty
Ejemplo conceptual:
prepare_command=npm install
prepare_enabled=true
verify_command=npm test
verify_enabled=true
También se pueden solicitar en la creación:
worktree.sh create CA-example --base main --prepare --verify
Los comandos se ejecutan dentro del worktree, no en el repositorio principal.
La configuración se valida como datos. No se hace source del archivo ni se ejecuta directamente como shell.
Cierre normal y squash merge
4. complete
Comando:
worktree.sh complete <work-id> --base <branch>
El cierre normal realiza:
 1. Verificación de identidad del worktree.
 2. Verificación de que la branch no cambió inesperadamente.
 3. Verificación de que el worktree está limpio.
 4. Verificación de que existe al menos un commit propio.
 5. Verificación de stashes pendientes.
 6. Verificación de submodules, si existen.
 7. Verificación de que el destino está en un estado compatible.
 8. Squash merge del branch de trabajo a la rama base.
 9. Validación del commit squash.
10. Deinitialización de submodules.
11. Retirada del worktree.
12. Eliminación condicionada de la branch de trabajo.
13. Registro final como cerrado.
El commit del worktree debe existir antes de ejecutar complete.
El resultado esperado es un único commit squash en la base, cuyo parent debe coincidir con el HEAD de la base previo al cierre.
5. Journal de cierre reanudable
complete no es una operación monolítica. Tiene fases persistidas:
created
init_started
initialized
merge_started
merged
deinit_started
deinitialized
remove_started
removed
branch_cleanup_started
closed
Esto permite recuperarse de interrupciones entre operaciones sensibles.
Por ejemplo, si el proceso muere después del squash pero antes de retirar el worktree, una nueva ejecución no vuelve a hacer otro squash. Lee el journal, verifica el estado real y continúa desde la fase correcta.
También valida:
- SHA original de la branch.
- SHA del commit squash.
- Parent del commit squash.
- Existencia o ausencia del worktree.
- Registro real en git worktree.
- Coincidencia entre HEAD, branch y ruta.
- Estado de los submodules.
Si el estado es ambiguo, se detiene sin avanzar.
Protección contra destino dirty
6. Rechazo por defecto
Si el repositorio principal tiene cambios sin commitear, complete rechaza la operación:
No se modificó nada.
Esto incluye:
- Cambios staged.
- Cambios unstaged.
- Archivos untracked.
- Nombres con espacios.
- Nombres con comillas.
- Nombres con saltos de línea.
- Nombres con tabs.
- Nombres que empiezan por -.
- Casos potencialmente peligrosos para comandos shell.
El rechazo evita generar comandos derivados de rutas controladas por el usuario o por el repositorio.
7. Preservación transaccional opt-in
Si el desarrollador lo autoriza explícitamente:
worktree.sh complete <work-id> --base main --preserve-dirty
o si existe configuración equivalente:
{
  "preserveDirty": true
}
el script puede preservar temporalmente los cambios del destino.
La transacción:
1. Captura los cambios tracked.
2. Captura archivos untracked.
3. Guarda los respaldos en refs privadas:
refs/flowtask/backups/<tx-id>
refs/flowtask/backups/<tx-id>-untracked
4. Registra cada fase en un journal.
5. Limpia temporalmente el destino.
6. Ejecuta el squash merge.
7. Restaura el estado fino del destino.
8. Marca la transacción como restaurada.
No utiliza la lista pública de stashes para esta operación.
Los estados se conservan bajo:
<git-common-dir>/worktree-manager/transactions/
y existe un espejo compatible en:
.flowtask/backups/
Estados de la transacción
captured
merge_started
merged
restored
pending_manual
Si la restauración automática encuentra una colisión, no elimina nada. Deja la transacción en pending_manual y muestra instrucciones para resolverla manualmente.
8. recover
Comando:
worktree.sh recover [<transaction-id>]
Sin identificador usa la transacción pendiente más reciente.
recover puede:
- Limpiar una captura interrumpida.
- Reanudar un merge.
- Restaurar cambios preservados.
- Resolver transacciones interrumpidas por crash.
- Repetirse de forma idempotente.
- Bloquearse si detecta drift o estado ambiguo.
recover no retira automáticamente un worktree o una branch mediante la ruta interna de cierre. Para eliminar recursos usa el cleanup público.
Cleanup público
9. cleanup
Comando:
worktree.sh cleanup <work-id> --base main
El cleanup público no hace merge.
Por defecto solo elimina un worktree si no tiene:
- Cambios locales.
- Commits propios.
- Estado pendiente.
Para descartar explícitamente:
worktree.sh cleanup <work-id> --base main --discard
--discard es destructivo y requiere indicarse expresamente.
El cleanup público permanece separado de:
- El journal interno de complete.
- Las transacciones --preserve-dirty.
- El lifecycle target-direct.
Listado y mantenimiento
10. list
worktree.sh list
Delegación a:
git worktree list --porcelain
Actualmente devuelve únicamente el repositorio principal:
worktree /Users/saez/Proyects/FlowTask
branch refs/heads/main
11. prune
worktree.sh prune
Hace dos cosas:
1. Ejecuta git worktree prune para limpiar metadata Git obsoleta.
2. Inspecciona .worktrees/ y reporta directorios que parecen worktrees huérfanos.
No elimina arbitrariamente esos directorios. Los reporta para que puedan inspeccionarse.
También evita interpretar submodules anidados como worktrees huérfanos.
Locks y concurrencia
El script utiliza locks por recurso:
work/<id>
destination
registry
Los nombres se codifican para evitar colisiones de path.
Las operaciones create, complete, cleanup, recover y prune adquieren locks antes de modificar recursos.
El orden de adquisición se normaliza para reducir deadlocks.
La variante target-direct usa además locks separados para:
target
parent
con orden:
target → parent
Si el recurso está ocupado, la operación falla sin mutar el estado.
Lifecycle target-direct para submodules
Esta es la funcionalidad incorporada en el último CA.
Se activa solamente con una invocación explícita como:
worktree.sh \
  --repo <submodule> \
  --parent-repo <parent> \
  create <CA_ID> \
  --target submodule \
  --submodule-path <path> \
  --base <branch> \
  --link-parent staged-only
Diferencia frente al lifecycle normal
En el lifecycle parent-only:
parent repo
└── .worktrees/CA-ID
En target-direct:
parent repo
└── submodule path

submodule repo
└── .worktrees/CA-ID
El worktree se crea en el repositorio real del submodule.
No se crea ni se conserva un worktree adicional del parent.
12. Target-direct create
Crea únicamente:
<target>/.worktrees/<CA_ID>
worktree/<CA_ID>
Valida:
- Que target y parent sean repositorios distintos y válidos.
- Que el .gitmodules del parent contenga el submodule.
- Que el path corresponda al target.
- Que el gitlink sea realmente 160000.
- Que el SHA sea válido.
- Que la rama no exista.
- Que el path no exista.
- Que Git sea exactamente 2.54.0.
13. Target-direct link-parent
Comando conceptual:
worktree.sh \
  --repo <submodule> \
  --parent-repo <parent> \
  link-parent <CA_ID> \
  --target submodule \
  --submodule-path <path> \
  --link-parent staged-only
Hace únicamente esto:
- Captura HEAD del parent.
- Captura el diff staged binario.
- Captura el gitlink actual.
- Captura el índice completo.
- Calcula hashes del índice y de las evidencias.
- Actualiza el gitlink en el índice del parent.
- Deja el cambio staged.
No hace:
- Commit.
- Merge.
- Push.
- Limpieza del parent.
- Creación de un worktree del parent.
14. Target-direct abort
Puede restaurar el índice del parent cuando el estado sigue siendo clasificable:
clasificación A: sin cambios externos
clasificación B: solo el cambio esperado
Si encuentra:
- Drift del HEAD del parent.
- Cambios ajenos en el índice.
- Cambio inesperado del gitlink.
- Estado no clasificable.
se detiene y conserva la evidencia.
No pisa cambios externos.
15. Target-direct complete
Aunque no aparece todavía en la sección de ayuda pública, el parser sí lo implementa.
Su comportamiento es:
 1. Rehidratar el descriptor persistido.
 2. Validar la identidad target/parent.
 3. Verificar el SHA staged del gitlink.
 4. Verificar que el HEAD del parent no cambió.
 5. Verificar que el índice todavía representa el cambio esperado.
 6. Validar que el worktree target esté limpio.
 7. Retirar únicamente el worktree target.
 8. Retirar únicamente su branch.
 9. No modificar el commit ni el índice del parent.
10. Ser idempotente si ya fue completado.
16. Target-direct recover
También está implementado aunque no está listado claramente en la ayuda.
Rehidrata el descriptor desde disco y reconcilia según la fase persistida:
verified
staged
staged_started
snapshot_captured
complete_validated
remove_started
removed
closed
Si detecta drift, devuelve error y conserva la evidencia.
Descriptor seguro Runner → Constructor
El target-direct no transporta estado arbitrario mediante argumentos sueltos.
Utiliza un descriptor persistido con campos estrictos:
descriptor_version
operation
target_kind
target_repo
target_common_dir
parent_repo
parent_common_dir
submodule_path
gitlink_sha
target_head
base
base_sha
branch
worktree_path
link_parent
namespace
owner
phase
tx_id
index_snapshot_ref
target-direct-transport.js valida:
- Keys permitidas.
- Keys duplicadas.
- Campos obligatorios.
- Paths absolutos normalizados.
- SHA válidos.
- Operaciones permitidas.
- Fases permitidas.
- Identidad branch/path.
- Namespace esperado.
- Formato UTF-8/LF.
- Ausencia de saltos de línea inyectados.
Luego serializa, persiste y rehidrata el descriptor antes de entregarlo al Constructor.
Cobertura de tests
La suite principal cubre:
- Creación y listado.
- Hotfix nested.
- Conflictos de merge.
- IDs complejos.
- Worktrees sin commit.
- Cambios locales.
- Stashes pendientes.
- Destino dirty.
- Nombres hostiles.
- --discard.
- --preserve-dirty.
- Recuperación después de crash.
- Journals corruptos.
- Divergencia de SHA.
- Locks.
- Configuración.
- Prepare/verify.
- Submodules anidados.
- Inicialización fallida.
- Deinitialización.
- Prune.
- Target-direct.
- Abort y reconciliación del índice.
- Drift del parent.
- Drift del gitlink.
- Recuperación target-direct.
- Idempotencia de complete.
Resultado actual:
worktree-hotfix.test.js: 103/103
target-direct-transport + installer: 35/35
Límites actuales
Hay algunos límites intencionales y una inconsistencia documental:
1. La ayuda CLI está incompleta para target-direct  
La implementación acepta complete y recover, pero --help solo muestra create, link-parent y abort.
2. Target-direct exige exactamente Git 2.54.0  
No es una ruta genérica para cualquier versión de Git.
3. Target-direct solo soporta submodules y staged-only  
No implementa todavía subtree synchronization, push, commit o merge del parent.
4. Los conflictos de merge no se resuelven automáticamente  
El worktree y la branch se conservan para intervención posterior.
5. La preservación de cambios dirty es opt-in  
Nunca debe activarse implícitamente en un flujo automatizado.
6. Submodules, sparse-checkout y filtros Git bloquean la preservación transaccional  
Se consideran estados no soportados para preservar cambios de forma segura.
7. prune reporta huérfanos, pero no los borra  
La eliminación requiere una decisión explícita.
8. El commit actual está localmente integrado pero no publicado en origin/main  
Esto es lo único pendiente desde el punto de vista de sincronización Git, no del funcionamiento local.
En resumen: el script ya no es un wrapper básico de git worktree. Actualmente funciona como un gestor transaccional con lifecycle completo, recuperación por journal, locks, preservación segura de cambios locales y una segunda modalidad especializada para operar sobre submodules directamente.