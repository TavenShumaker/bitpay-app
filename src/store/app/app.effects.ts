import {JsonMap, UserTraits} from '@segment/analytics-react-native';
import BitAuth from 'bitauth';
import i18n from 'i18next';
import {debounce} from 'lodash';
import {DeviceEventEmitter, Linking, Platform} from 'react-native';
import Braze from 'react-native-appboy-sdk';
import RNBootSplash from 'react-native-bootsplash';
import InAppBrowser, {
  InAppBrowserOptions,
} from 'react-native-inappbrowser-reborn';
import {
  checkNotifications,
  requestNotifications,
  RESULTS,
} from 'react-native-permissions';
import {requestTrackingPermission} from 'react-native-tracking-transparency';
import uuid from 'react-native-uuid';
import {batch} from 'react-redux';
import {AppActions} from '.';
import BitPayApi from '../../api/bitpay';
import GraphQlApi from '../../api/graphql';
import UserApi from '../../api/user';
import {OnGoingProcessMessages} from '../../components/modal/ongoing-process/OngoingProcess';
import {Network} from '../../constants';
import Segment from '../../lib/segment';
import {CardScreens} from '../../navigation/card/CardStack';
import {TabsScreens} from '../../navigation/tabs/TabsStack';
import {isAxiosError} from '../../utils/axios';
import {sleep} from '../../utils/helper-methods';
import {BitPayIdEffects} from '../bitpay-id';
import {CardEffects} from '../card';
import {coinbaseInitialize} from '../coinbase';
import {Effect, RootState} from '../index';
import {LocationEffects} from '../location';
import {LogActions} from '../log';
import {WalletActions} from '../wallet';
import {walletConnectInit} from '../wallet-connect/wallet-connect.effects';
import {
  deferredImportMnemonic,
  startMigration,
  startWalletStoreInit,
} from '../wallet/effects';
import {
  setAnnouncementsAccepted,
  setAppFirstOpenEventComplete,
  setAppFirstOpenEventDate,
  setBrazeEid,
  setConfirmedTxAccepted,
  setEmailNotificationsAccepted,
  setMigrationComplete,
  setNotificationsAccepted,
  showBlur,
} from './app.actions';
import {AppIdentity} from './app.models';
import {
  findKeyByKeyId,
  findWalletByIdHashed,
  getAllWalletClients,
} from '../wallet/utils/wallet';
import {navigationRef, RootStacks, SilentPushEvent} from '../../Root';
import {
  startUpdateAllKeyAndWalletStatus,
  startUpdateWalletStatus,
} from '../wallet/effects/status/status';
import {createWalletAddress} from '../wallet/effects/address/address';
import {DeviceEmitterEvents} from '../../constants/device-emitter-events';
import {
  APP_ANALYTICS_ENABLED,
  APP_DEEPLINK_PREFIX,
} from '../../constants/config';
import {updatePortfolioBalance} from '../wallet/wallet.actions';
import {setContactMigrationComplete} from '../contact/contact.actions';
import {startContactMigration} from '../contact/contact.effects';

// Subscription groups (Braze)
const PRODUCTS_UPDATES_GROUP_ID = __DEV__
  ? '27c86a0b-2a91-4383-b05b-5e671554f186'
  : 'fe2146a6-f5ed-4df7-81de-7ed9cd019d23';
const OFFERS_AND_PROMOTIONS_GROUP_ID = __DEV__
  ? '6be103aa-4df0-46f6-a3fa-438e61aadced'
  : '1d1db929-909d-40e0-93ec-34106ea576b4';

export const startAppInit = (): Effect => async (dispatch, getState) => {
  try {
    dispatch(LogActions.clear());
    dispatch(LogActions.info(`Initializing app (${__DEV__ ? 'D' : 'P'})...`));

    const {APP, BITPAY_ID, WALLET} = getState();
    const {network, pinLockActive, biometricLockActive, colorScheme} = APP;

    dispatch(LogActions.debug(`Network: ${network}`));
    dispatch(LogActions.debug(`Theme: ${colorScheme || 'system'}`));

    const {appFirstOpenData, onboardingCompleted, migrationComplete} =
      getState().APP;

    const {contactMigrationComplete} = getState().CONTACT;

    if (!appFirstOpenData?.firstOpenDate) {
      dispatch(setAppFirstOpenEventDate(Math.floor(Date.now() / 1000)));
      dispatch(LogActions.info('success [setAppFirstOpenEventDate]'));
    }

    // init analytics -> post onboarding or migration
    if (onboardingCompleted) {
      await dispatch(askForTrackingPermissionAndEnableSdks(true));
    }

    await dispatch(startWalletStoreInit());

    if (!contactMigrationComplete) {
      await dispatch(startContactMigration());
      dispatch(setContactMigrationComplete());
      dispatch(LogActions.info('success [setContactMigrationComplete]'));
    }

    if (!migrationComplete) {
      await dispatch(startMigration());
      dispatch(setMigrationComplete());
      dispatch(LogActions.info('success [setMigrationComplete]'));
    }

    const token = BITPAY_ID.apiToken[network];
    const isPaired = !!token;
    const identity = dispatch(initializeAppIdentity());

    await dispatch(initializeApi(network, identity));

    dispatch(LocationEffects.getCountry());

    if (isPaired) {
      try {
        dispatch(
          LogActions.info(
            'App is paired with BitPayID, refreshing user data...',
          ),
        );

        const {errors, data} = await UserApi.fetchInitialUserData(token);

        // handle partial errors
        if (errors) {
          const msg = errors
            .map(e => `${e.path.join('.')}: ${e.message}`)
            .join(',\n');

          dispatch(
            LogActions.error(
              'One or more errors occurred while fetching initial user data:\n' +
                msg,
            ),
          );
        }
        await dispatch(BitPayIdEffects.startBitPayIdStoreInit(data.user));
        dispatch(CardEffects.startCardStoreInit(data.user));
      } catch (err: any) {
        if (isAxiosError(err)) {
          dispatch(LogActions.error(`${err.name}: ${err.message}`));
          dispatch(LogActions.error(err.config.url));
          dispatch(LogActions.error(JSON.stringify(err.config.data || {})));
        } else if (err instanceof Error) {
          dispatch(LogActions.error(`${err.name}: ${err.message}`));
        } else {
          dispatch(LogActions.error(JSON.stringify(err)));
        }

        dispatch(
          LogActions.info(
            'Failed to refresh user data. Continuing initialization.',
          ),
        );
      }
    }

    // splitting inits into store specific ones as to keep it cleaner in the main init here
    await dispatch(walletConnectInit());
    await dispatch(initializeBrazeContent());

    // Update Coinbase
    dispatch(coinbaseInitialize());

    // Deferred Import
    if (WALLET.deferredImport) {
      const {importData, opts} = WALLET.deferredImport;
      dispatch(deferredImportMnemonic(importData, opts, 'deferredImport'));
    }

    dispatch(showBlur(pinLockActive || biometricLockActive));
    dispatch(AppActions.successAppInit());
    await sleep(500);
    dispatch(LogActions.info('Initialized app successfully.'));
    dispatch(LogActions.debug(`Pin Lock Active: ${pinLockActive}`));
    dispatch(LogActions.debug(`Biometric Lock Active: ${biometricLockActive}`));
    RNBootSplash.hide({fade: true}).then(() => {
      // avoid splash conflicting with modal in iOS
      // https://stackoverflow.com/questions/65359539/showing-a-react-native-modal-right-after-app-startup-freezes-the-screen-in-ios
      if (pinLockActive) {
        dispatch(AppActions.showPinModal({type: 'check'}));
      }
      if (biometricLockActive) {
        dispatch(AppActions.showBiometricModal({}));
      }

      dispatch(AppActions.appInitCompleted());
      DeviceEventEmitter.emit(DeviceEmitterEvents.APP_INIT_COMPLETED);
    });
  } catch (err: unknown) {
    let errorStr;
    if (err instanceof Error) {
      errorStr = err.message;
    } else {
      errorStr = JSON.stringify(err);
    }
    // wait for navigationRef
    await sleep(2000);
    if (errorStr !== 'Network Error') {
      // Avoid lock the app in Debug view
      dispatch(AppActions.failedAppInit());
    }
    dispatch(LogActions.error('Failed to initialize app: ' + errorStr));
    await sleep(500);
    dispatch(showBlur(false));
    RNBootSplash.hide();
  }
};

/**
 * Checks to ensure that the App Identity is defined, else generates a new one.
 * @returns The App Identity.
 */
const initializeAppIdentity =
  (): Effect<AppIdentity> => (dispatch, getState) => {
    const {APP} = getState();
    let identity = APP.identity[APP.network];

    dispatch(LogActions.info('Initializing App Identity...'));

    if (!identity || !Object.keys(identity).length || !identity.priv) {
      try {
        dispatch(LogActions.info('Generating new App Identity...'));

        identity = BitAuth.generateSin();

        dispatch(AppActions.successGenerateAppIdentity(APP.network, identity));
      } catch (error) {
        dispatch(
          LogActions.error(
            'Error generating App Identity: ' + JSON.stringify(error),
          ),
        );
        dispatch(AppActions.failedGenerateAppIdentity());
      }
    }

    dispatch(LogActions.info('Initialized App Identity successfully.'));

    return identity;
  };

/**
 * Initializes APIs for the given network and identity.
 * @param network
 * @param identity
 * @returns void
 */
const initializeApi =
  (network: Network, identity: AppIdentity): Effect =>
  () => {
    BitPayApi.init(network, identity);
    GraphQlApi.init(network, identity);
  };

/**
 * Initializes Braze content by setting up an event subscription for content
 * changes, checking for a paired user, then requesting a Braze refresh.
 *
 * The subscription will fetch latest content when it receives an update event.
 * @returns void
 */
export const initializeBrazeContent =
  (): Effect => async (dispatch, getState) => {
    try {
      dispatch(LogActions.info('Initializing Braze content...'));
      const {APP} = getState();

      let contentCardSubscription = APP.brazeContentCardSubscription;

      if (contentCardSubscription) {
        contentCardSubscription.subscriber?.removeAllSubscriptions();
        contentCardSubscription = null;
      }

      // When triggering a new Braze session (via changeUser), it may take a bit for campaigns/canvases to propogate.
      const INIT_CONTENT_CARDS_POLL_INTERVAL = 5000;
      const MAX_RETRIES = 3;
      let currentRetry = 0;

      contentCardSubscription = Braze.addListener(
        Braze.Events.CONTENT_CARDS_UPDATED,
        async () => {
          const isInitializing = currentRetry < MAX_RETRIES;

          dispatch(
            isInitializing
              ? LogActions.debug(
                  'Braze content cards updated, fetching latest content cards...',
                )
              : LogActions.info(
                  'Braze content cards updated, fetching latest content cards...',
                ),
          );

          const contentCards = await Braze.getContentCards();

          if (contentCards.length) {
            currentRetry = MAX_RETRIES;
          } else {
            if (isInitializing) {
              currentRetry++;
              await sleep(INIT_CONTENT_CARDS_POLL_INTERVAL);
              dispatch(
                LogActions.debug(
                  `0 content cards found. Retrying... (${currentRetry} of ${MAX_RETRIES})`,
                ),
              );
              Braze.requestContentCardsRefresh();
              return;
            }
          }

          dispatch(
            LogActions.info(
              `${contentCards.length} content ${
                contentCards.length === 1 ? 'card' : 'cards'
              } fetched from Braze.`,
            ),
          );
          dispatch(AppActions.brazeContentCardsFetched(contentCards));
        },
      );

      let eid = APP.brazeEid;

      if (!eid) {
        dispatch(LogActions.debug('Generating EID for anonymous user...'));
        eid = uuid.v4().toString();
        dispatch(setBrazeEid(eid));
      }

      // TODO: we should only identify logged in users, but identifying anonymous users is currently baked into some bitcore stuff, will need to refactor
      dispatch(Analytics.identify(eid));

      dispatch(LogActions.info('Successfully initialized Braze.'));
      dispatch(AppActions.brazeInitialized(contentCardSubscription));
    } catch (err) {
      const errMsg = 'Something went wrong while initializing Braze.';

      dispatch(LogActions.error(errMsg));
      dispatch(
        LogActions.error(
          err instanceof Error ? err.message : JSON.stringify(err),
        ),
      );
    } finally {
      dispatch(LogActions.info('Initializing Braze content complete.'));
    }
  };

/**
 * Requests a refresh for Braze content.
 * @returns void
 */
export const requestBrazeContentRefresh = (): Effect => async dispatch => {
  try {
    dispatch(LogActions.info('Refreshing Braze content...'));

    Braze.requestContentCardsRefresh();
  } catch (err) {
    const errMsg = 'Something went wrong while refreshing Braze content.';

    dispatch(LogActions.error(errMsg));
    dispatch(
      LogActions.error(
        err instanceof Error ? err.message : JSON.stringify(err),
      ),
    );
  }
};

export const startOnGoingProcessModal =
  (message: OnGoingProcessMessages): Effect<Promise<void>> =>
  async (dispatch, getState: () => RootState) => {
    const store: RootState = getState();

    // if modal currently active dismiss and sleep to allow animation to complete before showing next
    if (store.APP.showOnGoingProcessModal) {
      dispatch(AppActions.dismissOnGoingProcessModal());
      await sleep(500);
    }

    dispatch(AppActions.showOnGoingProcessModal(message));
    return sleep(100);
  };

/**
 * Open a URL with the InAppBrowser if available, else lets the device handle the URL.
 * @param url
 * @param options
 * @returns
 */
export const openUrlWithInAppBrowser =
  (url: string, options: InAppBrowserOptions = {}): Effect =>
  async dispatch => {
    let isIabAvailable = false;

    try {
      isIabAvailable = await InAppBrowser.isAvailable();
    } catch (err) {
      console.log(err);
    }

    const handler = isIabAvailable ? 'InAppBrowser' : 'external app';

    try {
      dispatch(LogActions.info(`Opening URL ${url} with ${handler}`));

      if (isIabAvailable) {
        // successfully resolves after IAB is cancelled or dismissed
        const result = await InAppBrowser.open(url, {
          // iOS options
          animated: true,
          modalEnabled: true,
          modalPresentationStyle: 'pageSheet',

          // android options
          forceCloseOnRedirection: false,
          hasBackButton: true,
          showInRecents: true,

          ...options,
        });

        dispatch(
          LogActions.info(`InAppBrowser closed with type: ${result.type}`),
        );
      } else {
        // successfully resolves if an installed app handles the URL,
        // or the user confirms any presented 'open' dialog
        await Linking.openURL(url);
      }
    } catch (err) {
      const logMsg = `Error opening URL ${url} with ${handler}.\n${JSON.stringify(
        err,
      )}`;

      dispatch(LogActions.error(logMsg));
    }
  };

export const askForTrackingPermissionAndEnableSdks =
  (appInit: boolean = false): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    dispatch(
      LogActions.info('starting [askForTrackingPermissionAndEnableSdks]'),
    );
    const trackingStatus = await requestTrackingPermission();
    const isAuthorizedByUser = ['authorized', 'unavailable'].includes(
      trackingStatus,
    );

    if (APP_ANALYTICS_ENABLED && isAuthorizedByUser) {
      dispatch(
        LogActions.info('[askForTrackingPermissionAndEnableSdks] - setup init'),
      );

      try {
        const {appFirstOpenData, appOpeningWasTracked, brazeEid} =
          getState().APP;

        if (!Segment.getClient()) {
          await Segment.init({eid: brazeEid});
        }

        if (appInit) {
          if (!appOpeningWasTracked && appFirstOpenData) {
            const {firstOpenDate, firstOpenEventComplete} = appFirstOpenData;

            if (firstOpenDate && !firstOpenEventComplete) {
              dispatch(setAppFirstOpenEventComplete());
              dispatch(
                Analytics.track('First Opened App', {
                  date: firstOpenDate || '',
                }),
              );
            } else {
              dispatch(Analytics.track('Last Opened App', {}));
            }

            dispatch(AppActions.appOpeningWasTracked());
          }
        }
      } catch (err) {
        dispatch(LogActions.error('Segment setup failed'));
        dispatch(LogActions.error(JSON.stringify(err)));
      }
    }
    dispatch(
      LogActions.info('complete [askForTrackingPermissionAndEnableSdks]'),
    );
  };

/**
 * @deprecated Use `dispatch(Analytics.track(event, properties))` instead.
 */
export const logSegmentEvent = (
  _eventType: 'track',
  event: string,
  properties: JsonMap = {},
) => {
  return Analytics.track(event, properties);
};

export const Analytics = {
  /**
   * Makes a call to identify a user through the analytics SDK.
   *
   * @param user database ID (or email address) for this user.
   * If you don't have a userId but want to record traits, you should pass nil.
   * For more information on how we generate the UUID and Apple's policies on IDs, see https://segment.io/libraries/ios#ids
   * @param traits A dictionary of traits you know about the user. Things like: email, name, plan, etc.
   */
  identify:
    (
      user: string | undefined,
      traits?: UserTraits | undefined,
    ): Effect<Promise<void>> =>
    () => {
      return Segment.identify(user, traits);
    },

  /**
   * Makes a call to record a screen view through the analytics SDK.
   *
   * @param name The title of the screen being viewed.
   * @param properties A dictionary of properties for the screen view event.
   * If the event was 'Added to Shopping Cart', it might have properties like price, productType, etc.
   */
  screen:
    (name: string, properties: JsonMap = {}): Effect<Promise<void>> =>
    () => {
      return Segment.screen(name, properties);
    },

  /**
   * Record the actions your users perform through the analytics SDK.
   *
   * When a user performs an action in your app, you'll want to track that action for later analysis.
   * Use the event name to say what the user did, and properties to specify any interesting details of the action.
   *
   * @param event The name of the event you're tracking.
   * The SDK recommend using human-readable names like `Played a Song` or `Updated Status`.
   * @param properties A dictionary of properties for the event.
   * If the event was 'Added to Shopping Cart', it might have properties like price, productType, etc.
   */
  track:
    (event: string, properties: JsonMap = {}): Effect<Promise<void>> =>
    () => {
      return Segment.track(`BitPay App - ${event}`, properties);
    },
};

export const subscribePushNotifications =
  (walletClient: any, eid: string): Effect =>
  dispatch => {
    const opts = {
      externalUserId: eid,
      platform: Platform.OS,
      packageName: 'BitPay',
      walletId: walletClient.credentials.walletId,
    };
    walletClient.pushNotificationsSubscribe(opts, (err: any) => {
      if (err) {
        dispatch(
          LogActions.error(
            'Push Notifications error subscribing: ' + JSON.stringify(err),
          ),
        );
      }
    });
  };

export const unSubscribePushNotifications =
  (walletClient: any, eid: string): Effect =>
  dispatch => {
    walletClient.pushNotificationsUnsubscribe(eid, (err: any) => {
      if (err) {
        dispatch(
          LogActions.error(
            'Push Notifications error unsubscribing: ' + JSON.stringify(err),
          ),
        );
      } else {
        dispatch(
          LogActions.info(
            'Push Notifications success unsubscribing: ' +
              walletClient.credentials.walletName,
          ),
        );
      }
    });
  };

export const subscribeEmailNotifications =
  (
    walletClient: any,
    prefs: {email: string; language: string; unit: string},
  ): Effect<Promise<void>> =>
  async dispatch => {
    walletClient.savePreferences(prefs, (err: any) => {
      if (err) {
        dispatch(
          LogActions.error(
            'Email Notifications error subscribing: ' + JSON.stringify(err),
          ),
        );
      } else {
        dispatch(
          LogActions.info(
            'Email Notifications success subscribing: ' +
              walletClient.credentials.walletName,
          ),
        );
      }
    });
  };

export const unSubscribeEmailNotifications =
  (walletClient: any): Effect<Promise<void>> =>
  async dispatch => {
    walletClient.savePreferences({email: ''}, (err: any) => {
      if (err) {
        dispatch(
          LogActions.error(
            'Email Notifications error unsubscribing: ' + JSON.stringify(err),
          ),
        );
      } else {
        dispatch(
          LogActions.info(
            'Email Notifications success unsubscribing: ' +
              walletClient.credentials.walletName,
          ),
        );
      }
    });
  };

export const checkNotificationsPermissions = async (): Promise<boolean> => {
  const {status} = await checkNotifications().catch(() => ({status: null}));

  return status === RESULTS.GRANTED;
};

export const renewSubscription = (): Effect => (dispatch, getState) => {
  const {
    WALLET: {keys},
    APP,
  } = getState();

  getAllWalletClients(keys).then(walletClients => {
    walletClients.forEach(walletClient => {
      dispatch(subscribePushNotifications(walletClient, APP.brazeEid!));
    });
  });
};

export const requestNotificationsPermissions = async (): Promise<boolean> => {
  const {status} = await requestNotifications([
    'alert',
    'badge',
    'sound',
  ]).catch(() => ({status: null}));

  return status === RESULTS.GRANTED;
};

export const setNotifications =
  (accepted: boolean): Effect =>
  (dispatch, getState) => {
    dispatch(setNotificationsAccepted(accepted));
    const value = accepted
      ? Braze.NotificationSubscriptionTypes.SUBSCRIBED
      : Braze.NotificationSubscriptionTypes.UNSUBSCRIBED;

    Braze.setPushNotificationSubscriptionType(value);
    const {
      WALLET: {keys},
      APP,
    } = getState();

    getAllWalletClients(keys).then(walletClients => {
      if (accepted) {
        walletClients.forEach(walletClient => {
          dispatch(subscribePushNotifications(walletClient, APP.brazeEid!));
        });
      } else {
        walletClients.forEach(walletClient => {
          dispatch(unSubscribePushNotifications(walletClient, APP.brazeEid!));
        });
      }
      dispatch(LogActions.info('Push Notifications: ' + value));
    });
  };

export const setConfirmTxNotifications =
  (accepted: boolean): Effect =>
  async dispatch => {
    dispatch(setConfirmedTxAccepted(accepted));
  };

export const setAnnouncementsNotifications =
  (accepted: boolean): Effect =>
  async dispatch => {
    dispatch(setAnnouncementsAccepted(accepted));
    if (accepted) {
      Braze.addToSubscriptionGroup(OFFERS_AND_PROMOTIONS_GROUP_ID);
      Braze.addToSubscriptionGroup(PRODUCTS_UPDATES_GROUP_ID);
    } else {
      Braze.removeFromSubscriptionGroup(PRODUCTS_UPDATES_GROUP_ID);
      Braze.removeFromSubscriptionGroup(OFFERS_AND_PROMOTIONS_GROUP_ID);
    }
  };

export const setEmailNotifications =
  (
    accepted: boolean,
    email: string | null,
    agreedToMarketingCommunications?: boolean,
  ): Effect =>
  (dispatch, getState) => {
    const _email = accepted ? email : null;
    dispatch(setEmailNotificationsAccepted(accepted, _email));

    if (agreedToMarketingCommunications) {
      Braze.setEmailNotificationSubscriptionType(
        Braze.NotificationSubscriptionTypes.OPTED_IN,
      );
    } else {
      Braze.setEmailNotificationSubscriptionType(
        Braze.NotificationSubscriptionTypes.SUBSCRIBED,
      );
    }

    const {
      WALLET: {keys},
      APP,
    } = getState();

    getAllWalletClients(keys).then(walletClients => {
      if (accepted && email) {
        const prefs = {
          email,
          language: APP.defaultLanguage,
          unit: 'btc', // deprecated
        };
        walletClients.forEach(walletClient => {
          dispatch(subscribeEmailNotifications(walletClient, prefs));
        });
      } else {
        walletClients.forEach(walletClient => {
          dispatch(unSubscribeEmailNotifications(walletClient));
        });
      }
    });
  };

const _startUpdateAllKeyAndWalletStatus = debounce(
  async dispatch => {
    dispatch(startUpdateAllKeyAndWalletStatus({force: true}));
    DeviceEventEmitter.emit(DeviceEmitterEvents.WALLET_LOAD_HISTORY);
  },
  5000,
  {leading: true, trailing: false},
);

const _createWalletAddress = debounce(
  async (dispatch, wallet) => {
    dispatch(createWalletAddress({wallet, newAddress: true}));
  },
  5000,
  {leading: true, trailing: false},
);

const _startUpdateWalletStatus = debounce(
  async (dispatch, keyObj, wallet) => {
    await dispatch(startUpdateWalletStatus({key: keyObj, wallet, force: true}));
    dispatch(updatePortfolioBalance());
    DeviceEventEmitter.emit(DeviceEmitterEvents.WALLET_LOAD_HISTORY);
  },
  5000,
  {leading: true, trailing: false},
);

export const handleBwsEvent =
  (response: SilentPushEvent): Effect =>
  async (dispatch, getState) => {
    const {
      WALLET: {keys},
    } = getState();
    if (response && response.walletId) {
      const {wallet, keyId} = await findWalletByIdHashed(
        keys,
        response.walletId,
        response.tokenAddress,
      );
      if (!wallet || !keyId) {
        return;
      }

      if (
        !wallet.credentials.walletId &&
        response.notification_type !== 'NewBlock'
      ) {
        return;
      }

      // TODO showInappNotification(data);

      console.log(
        `BWS Event: ${response.notification_type}: `,
        JSON.stringify(response),
      );

      const keyObj = await findKeyByKeyId(keyId, keys);

      switch (response.notification_type) {
        case 'NewAddress':
          _createWalletAddress(dispatch, wallet);
          break;
        case 'NewBlock':
          if (response.network && response.network === 'livenet') {
            _startUpdateAllKeyAndWalletStatus(dispatch);
          }
          break;
        case 'TxProposalAcceptedBy':
        case 'TxProposalRejectedBy':
        case 'TxProposalRemoved':
        case 'NewOutgoingTx':
        case 'NewIncomingTx':
        case 'NewTxProposal':
        case 'TxConfirmation':
          _startUpdateWalletStatus(dispatch, keyObj, wallet);
          break;
      }
    }
  };

export const resetAllSettings = (): Effect => dispatch => {
  batch(() => {
    dispatch(AppActions.setColorScheme(null));
    dispatch(AppActions.showPortfolioValue(true));
    dispatch(
      AppActions.setDefaultAltCurrency({isoCode: 'USD', name: 'US Dollar'}),
    );
    dispatch(AppActions.setDefaultLanguage(i18n.language || 'en'));
    dispatch(WalletActions.setUseUnconfirmedFunds(false));
    dispatch(WalletActions.setCustomizeNonce(false));
    dispatch(WalletActions.setQueuedTransactions(false));
    dispatch(WalletActions.setEnableReplaceByFee(false));
    dispatch(LogActions.info('Reset all settings'));
  });
};

export const incomingLink =
  (url: string): Effect<boolean> =>
  (dispatch, getState) => {
    let handled = false;

    const parsed = url.replace(APP_DEEPLINK_PREFIX, '');

    if (parsed === 'card/offers') {
      const {APP, CARD} = getState();
      const cards = CARD.cards[APP.network];

      if (cards.length) {
        if (APP.appWasInit) {
          setTimeout(() => {
            handleDosh();
          }, 500);
        } else {
          DeviceEventEmitter.addListener(
            DeviceEmitterEvents.APP_INIT_COMPLETED,
            () => {
              handleDosh();
            },
          );
        }

        function handleDosh() {
          navigationRef.navigate(RootStacks.TABS, {
            screen: TabsScreens.CARD,
            params: {
              screen: CardScreens.SETTINGS,
              params: {
                id: cards[0].id,
              },
            },
          });
          dispatch(CardEffects.startOpenDosh());
        }
      } else {
        navigationRef.navigate(RootStacks.TABS, {
          screen: TabsScreens.CARD,
          params: {
            screen: CardScreens.HOME,
          },
        });
      }

      handled = true;
    }

    return handled;
  };
