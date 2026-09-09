import type { IDataObject, IExecuteSingleFunctions, IHttpRequestOptions } from 'n8n-workflow';

/**
 * Turns the incoming item's binary field into the multipart body the voucher
 * document endpoint expects.
 *
 * This is the one endpoint that does not take JSON, so the node's default
 * Content-Type has to go: keeping it would send "application/json" while the
 * body is multipart, and the boundary the runtime generates would never reach
 * the server. Deleting the header lets the HTTP layer set both.
 */
export async function uploadBinaryFile(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName') as string;
	const binaryData = this.helpers.assertBinaryData(binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(binaryPropertyName);

	const body = new FormData();
	body.append(
		'file',
		new Blob([new Uint8Array(buffer)], { type: binaryData.mimeType }),
		binaryData.fileName ?? 'upload',
	);

	const headers: IDataObject = { ...(requestOptions.headers ?? {}) };
	delete headers['Content-Type'];
	delete headers['content-type'];

	requestOptions.headers = headers;
	requestOptions.body = body;
	requestOptions.json = false;

	return requestOptions;
}
