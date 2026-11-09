import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/app";

export const messages = {
  "error.app.externalLinkProtocol": "Alleen HTTP(S)-links kunnen in de externe browser worden geopend.",
  "error.app.notificationsUnsupported": "Dit systeem ondersteunt geen bureaubladmeldingen.",
  "error.app.notificationSettingsMissing": "Dit systeem heeft geen pagina met meldingsinstellingen.",
  "error.app.notReady": "OpenBot is niet klaar.",
  "error.app.macSecureStorageUnavailable": "De beveiligde opslag van macOS is niet beschikbaar.",
  "error.app.secretStorageUnavailable": "De opslag voor geheimen van het systeem is niet beschikbaar.",
  "error.app.remoteIdentityUnavailable": "De identiteit van de externe host is niet beschikbaar.",
  "error.app.iceServersMissing": "Remote Signal heeft nog geen ICE-servers gegeven.",
  "error.app.finishLocalTest": "Rond de lokale test af voordat je van beeldscherm wisselt.",
  "error.app.serverUrlInvalid":
    "De URL van de accountservice moet een https:-adres zijn, of een http:-adres op deze computer.",
  "error.app.serverUrlSignalInvalid":
    "De Signal-URL moet een wss:-adres zijn zonder gebruikersnaam en zonder wachtwoord.",
} as const satisfies PartialTranslation<typeof source>;
