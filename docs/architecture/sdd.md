> **Histórico:** este diseño metodológico no es un contrato de ejecución vigente. Consultá [../project-history.md](../project-history.md).

# Specification-Driven Development en FlowTask

```mermaid
flowchart TD
    AR["ANALISTA DE REQUISITOS<br/>Metodologías: SDD (Spec-Driven) + BDD (Behavior-Driven)<br/>Acción: Traduce requerimientos a reglas de negocio (BDD)<br/>Entregable: #quot;master-spec.md#quot; (Especificación Épica)"]

    TP["TRABAJO EN PARALELO"]

    DEV["DESARROLLADOR<br/>Metodologías: DDD + TDD<br/>Herramienta: Flowtask<br/>────────────<br/>1. Adaptación Spec:<br/>Usa agente modificado<br/>(ej. flowtask-subtasker)<br/>para dividir la épica<br/>en múltiples carpetas CA.<br/><br/>2. Arquitectura (DDD):<br/>Define reglas, capas y<br/>convenciones en la memoria<br/>persistente de Engram.<br/><br/>3. Planificación Técnica:<br/>Usa `flowtask-planner`.<br/><br/>4. CHECKPOINT HUMANO:<br/>Audita y aprueba el plan.<br/><br/>5. Implementación (TDD):<br/>Usa `flowtask-tester` para<br/>pruebas unitarias previas.<br/><br/>6. Construcción:<br/>`flowtask-constructor`<br/>escribe el código final."]

    QA["QA<br/>Metodología: BDD<br/>Herramienta: Automatización<br/>────────────<br/>1. Preparación (Día 1):<br/>Toma el #quot;master-spec.md#quot;<br/>creado por el analista.<br/><br/>2. Desarrollo de Pruebas:<br/>Programa pruebas de UI<br/>y de integración (E2E)<br/>basadas en los escenarios<br/>Dado/Cuando/Entonces."]

    VF["VALIDACIÓN FINAL<br/>QA ejecuta la suite E2E general<br/>contra el sistema ensamblado."]

    AR --> TP
    TP --> DEV
    TP --> QA
    DEV --> VF
    QA --> VF
```

```text
┌─────────────────────────────────────────────────────────────┐
│                  GLOSARIO DE ABREVIACIONES                  │
├─────────────────────────────────────────────────────────────┤
│ SDD : Spec-Driven Development (Desarrollo basado en la      │
│       especificación principal)                             │
│ BDD : Behavior-Driven Development (Desarrollo basado en el  │
│       comportamiento: Dado que / Cuando / Entonces)         │
│ DDD : Domain-Driven Design (Diseño guiado por el dominio:   │
│       Definición de arquitectura y convenciones)            │
│ TDD : Test-Driven Development (Desarrollo basado en pruebas:│
│       Crear pruebas unitarias antes que el código)          │
│ CA  : Criterio de Aceptación (La sub-tarea a desarrollar)   │
│ E2E : End-to-End (Pruebas de extremo a extremo del sistema) │
│ QA  : Quality Assurance (Aseguramiento de la Calidad)       │
└─────────────────────────────────────────────────────────────┘
```
