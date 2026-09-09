import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

/** A DNS label: letters, digits and inner hyphens, nothing else. */
const ACCOUNT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const HOST_SUFFIX = 'papierkram.de';

/**
 * Connection to one Papierkram account.
 *
 * Every account has its own host: the token is issued under
 * https://<account>.papierkram.de/einstellungen/api and is only valid against
 * that same subdomain, so account name and token belong together in one
 * credential rather than in the node.
 *
 * The API is part of the M and L packages and is documented as BETA. Requests
 * are metered in credits (10,000 per month for M, 20,000 for L); the response
 * carries X-Remaining-Quota, and once the quota is used up the API answers 429
 * for the rest of the month. That is worth knowing before pointing a one-minute
 * poll at it.
 */
export class PapierkramApi implements ICredentialType {
	name = 'papierkramApi';

	displayName = 'Papierkram API';

	documentationUrl = 'https://hilfe.papierkram.de/api/';

	icon = { light: 'file:papierkram.svg', dark: 'file:papierkram.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Account',
			name: 'subdomain',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'meinefirma',
			description:
				'Subdomain of the account, the part before ".papierkram.de". For https://meinefirma.papierkram.de this is "meinefirma" — the name only, not a URL and not a path.',
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Token created in the account settings under "Einstellungen -> API", the API section of the German interface. It is bound to the account above and stays valid until it is deleted there.',
		},
	];

	/**
	 * The account name ends up inside a hostname, so it is checked here rather
	 * than trusted: this runs for every request the node makes, including the
	 * credential test, which makes it the one place where the guarantee holds.
	 *
	 * The guarantee is that the token can only ever be sent to
	 * <account>.papierkram.de over HTTPS. A name containing "/", "@" or ":" would
	 * otherwise be a way to point a stored token at another host, and while only
	 * the credential's own owner can type it, "only the owner can" is a weak
	 * thing to rest a secret on.
	 */
	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const account = String(credentials.subdomain ?? '').trim();

		if (!ACCOUNT_NAME.test(account)) {
			throw new Error(
				`"${account}" is not a Papierkram account name. Enter only the part before ".papierkram.de", for example "meinefirma".`,
			);
		}

		const expected = `${account.toLowerCase()}.${HOST_SUFFIX}`;
		let target: URL;
		try {
			target = new URL(requestOptions.url ?? '', requestOptions.baseURL);
		} catch {
			throw new Error(`Cannot tell where this request would go: ${requestOptions.url ?? '(no URL)'}`);
		}

		if (target.protocol !== 'https:' || target.hostname.toLowerCase() !== expected) {
			throw new Error(
				`Refusing to send the Papierkram token to ${target.protocol}//${target.hostname}; this credential is only valid for https://${expected}.`,
			);
		}

		requestOptions.headers = {
			...requestOptions.headers,
			Authorization: `Bearer ${String(credentials.apiToken ?? '')}`,
		};

		return requestOptions;
	};

	/**
	 * /info is the cheapest endpoint and needs no permissions of its own, so a
	 * failure here means the account name or the token is wrong rather than that
	 * one resource is out of reach.
	 *
	 * The Accept header is not decoration: without it Papierkram answers 406 Not
	 * Acceptable, and the credential dialog then reports a working token as
	 * broken. The node itself sends the header through requestDefaults, so this
	 * only ever showed up in the test.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '=https://{{$credentials.subdomain}}.papierkram.de/api/v1',
			url: '/info',
			headers: { Accept: 'application/json' },
		},
	};
}
