import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

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
				'Subdomain of the account, the part before ".papierkram.de". For https://meinefirma.papierkram.de this is "meinefirma".',
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Token created under Einstellungen -> API. It is bound to the account above and stays valid until it is deleted there.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiToken}}',
			},
		},
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
