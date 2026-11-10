import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/app";

export const messages = {
  "error.app.externalLinkProtocol": "Solo se pueden abrir enlaces HTTP(S) en el navegador externo.",
  "error.app.notificationsUnsupported": "Este sistema no admite notificaciones de escritorio.",
  "error.app.notificationSettingsMissing": "Este sistema no tiene una página de ajustes de notificaciones.",
  "error.app.notReady": "OpenBot no está listo.",
  "error.app.macSecureStorageUnavailable": "El almacenamiento seguro de macOS no está disponible.",
  "error.app.secretStorageUnavailable": "El almacenamiento de secretos del sistema no está disponible.",
  "error.app.remoteIdentityUnavailable": "La identidad del host remoto no está disponible.",
  "error.app.iceServersMissing": "Remote Signal aún no ha proporcionado servidores ICE.",
  "error.app.finishLocalTest": "Termina la prueba local antes de cambiar de pantalla.",
  "error.app.serverUrlInvalid":
    "La URL del servicio de cuentas debe ser una dirección https:, o una dirección http: en este equipo.",
  "error.app.serverUrlSignalInvalid":
    "La URL de Signal debe ser una dirección wss: sin nombre de usuario ni contraseña.",
} as const satisfies PartialTranslation<typeof source>;
