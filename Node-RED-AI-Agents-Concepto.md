# Node-RED AI Agents Framework

## Visión General

Este documento describe una plataforma para Node-RED que permita construir agentes de Inteligencia Artificial visualmente utilizando LangChain.js y LangGraph como motor de ejecución.

La idea principal es llevar el paradigma moderno de Agentes IA al ecosistema Node-RED, permitiendo que usuarios técnicos y no técnicos puedan crear agentes complejos mediante flujos visuales sin necesidad de programar toda la lógica.

---

# Problema que se quiere resolver

Actualmente los agentes IA suelen desarrollarse mediante código.

Frameworks como:

- LangChain
- LangGraph
- Mastra
- OpenAI Agents
- Vercel AI SDK

permiten crear agentes capaces de:

- Mantener memoria.
- Utilizar herramientas (Tools).
- Tomar decisiones.
- Realizar razonamiento multi-paso.
- Ejecutar acciones externas.

Sin embargo, los usuarios de Node-RED trabajan principalmente con flujos visuales.

El objetivo es trasladar estas capacidades a Node-RED de forma nativa.

---

# Objetivo Principal

Crear un paquete llamado:

node-red-contrib-ai-agents

que permita construir agentes IA de forma completamente visual.

---

# Concepto Central

La arquitectura gira alrededor de tres elementos:

1. Agent AI
2. Tool
3. Tool Return

El agente actúa como cerebro.

Las Tools representan capacidades o acciones.

Tool Return devuelve el resultado al agente para continuar el razonamiento.

---

# Filosofía de Diseño

La herramienta debe sentirse como una extensión natural de Node-RED.

No debe obligar al usuario a escribir código complejo.

Las Tools deben construirse utilizando cualquier nodo existente de Node-RED.

Ejemplos:

- HTTP Request
- MQTT
- PostgreSQL
- Redis
- Telegram
- Home Assistant
- Modbus
- OPC-UA

De esta forma cualquier integración existente puede convertirse automáticamente en una herramienta para el agente.

---

# Nodo Agent AI

El Agent AI es el nodo principal.

Responsabilidades:

- Recibir mensajes de usuario. Ejemplo msg.payload
- Gestionar contexto.
- Gestionar memoria.
- Decidir qué Tool utilizar.
- Ejecutar Tools.
- Continuar el razonamiento tras cada Tool.
- Generar la respuesta final.

Configuración:

- System Prompt
- Model
- Memory
- Reasoning Effort
- Max Tokens
- Context Window Length
- Tools disponibles

---

# Sistema de Modelos

Los modelos deben configurarse mediante un Config Node reutilizable.

Proveedores soportados:

- OpenAI
- Gemini
- Anthropic
- DeepSeek
- OpenRouter
- Groq
- Ollama

El diseño debe permitir añadir nuevos proveedores sin modificar el nodo Agent AI.

---

# Sistema de Memoria

La memoria será un Config Node independiente.

Opciones:

## Memoria RAM

- Rápida.
- No persistente.

## Redis

- Compartida.
- Persistente.
- Escalable.

## PostgreSQL

- Persistencia completa.
- Historial conversacional.
- Checkpoints.
- Preparado para pgvector.

---

# Gestión de Session ID

La memoria debe soportar sesiones dinámicas.

Ejemplos:

msg.session_id

msg.payload.userId

msg.chat.id

Esto permite mantener conversaciones independientes para miles de usuarios.

---

# Concepto de Tool

Una Tool es una capacidad del agente.

Ejemplos:

- Consultar clima.
- Consultar clientes.
- Crear tickets.
- Enviar correos.
- Consultar bases de datos.
- Encender dispositivos.

La Tool debe existir como un nodo propio.

---

# Nodo Tool

El nodo Tool cumple dos funciones.

## Definición

Describe al agente:

- Nombre.
- Descripción.
- Esquema de entrada.
- Descripción de salida.

## Entrada de ejecución

Actúa como punto de entrada cuando el agente decide invocarla.

La Tool se convierte en un flujo independiente.

Ejemplo:

Tool → HTTP Request → Function → Tool Return

---

# Nodo Tool Return

Finaliza la ejecución de una Tool.

Responsabilidades:

- Capturar resultado.
- Resolver la llamada pendiente.
- Devolver el resultado al agente.

El usuario no debe cablear manualmente el retorno.

El runtime debe hacerlo automáticamente.

---

# Agent ↔ Tool RPC

Esta es la característica más importante del proyecto.

El sistema debe comportarse como una llamada RPC asíncrona.

Conceptualmente:

const result = await tool();

Aunque internamente se ejecute mediante flujos Node-RED.

Flujo:

Agent
→ Tool
→ Flujo interno de Tool
→ Tool Return
→ Agent
→ Continúa razonamiento

---

# Inspiración en Link Nodes

La experiencia de usuario debe inspirarse en:

- Link In
- Link Out
- Link Call

pero adaptada a agentes IA.

El resultado debe sentirse natural para usuarios habituales de Node-RED.

---

# Registro Automático de Tools

Todas las Tools deben registrarse automáticamente.

El Agent AI las descubrirá sin configuración adicional.

Desde el editor se podrá habilitar o deshabilitar cada Tool para un agente específico.

---

# Orquestación con LangGraph

LangGraph debe ser el motor de ejecución.

Ventajas:

- Estado persistente.
- Reanudación.
- Checkpoints.
- Tool Calling.
- Workflows complejos.
- Multiagente futuro.

---

# Persistencia PostgreSQL

Tablas propuestas:

- agent_sessions
- agent_messages
- agent_memory
- agent_checkpoints
- agent_tools
- agent_tool_calls
- agent_executions

---

# Casos de Uso

## Soporte al Cliente

El agente consulta clientes.

Consulta pedidos.

Abre tickets.

Responde automáticamente.

## Home Assistant

Control de dispositivos.

Consulta sensores.

Generación de acciones inteligentes.

## ERP

Creación de órdenes.

Consulta de inventario.

Análisis de datos.

## DevOps

Consulta APIs.

Monitorización.

Automatización operativa.

---

# Escalabilidad Futura

La arquitectura debe prepararse para:

- MCP
- MCP Tools
- Multi-Agent
- Supervisor Agents
- Human In The Loop
- Semantic Memory
- Vector Stores
- pgvector
- RAG
- Voice Agents
- Image Generation
- Structured Outputs

---

# Resultado Esperado

El resultado final debe ser una plataforma visual de agentes para Node-RED donde cualquier usuario pueda construir agentes avanzados conectando nodos del mismo modo que hoy construye automatizaciones.

Node-RED aportará la capa visual de integración.

LangChain.js y LangGraph aportarán la inteligencia, memoria y capacidades de razonamiento.

El objetivo es combinar lo mejor de ambos mundos en una solución preparada para producción y crecimiento futuro.
