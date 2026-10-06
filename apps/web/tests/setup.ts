// Initialise i18next for every test file.
//
// Components now render copy through t(); without this the global i18next
// instance is uninitialised and useTranslation returns raw keys ("nav.signOut"),
// so every assertion that looks for English text fails. Importing the real
// bootstrap also means the tests exercise the same resources the app ships.
import '../src/i18n';
