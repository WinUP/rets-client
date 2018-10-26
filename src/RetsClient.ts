import { createHash } from 'crypto';
import { cloneDeep } from 'lodash';

import {
    DefaultUriUrlRequestApi, Request, CoreOptions, OptionalUriUrl, RequestAPI, RequiredUriUrl, Response,
    defaults as defaultRequest, jar as requestJar
} from 'request';
import {
    IRetsResponse, IRetsBody, IClientConnection, RetsAction, RetsVersion, RetsRequestMethod, RetsServerError,
    RetsProcessingError, RetsClientError, IRetsQueryOptions, IRetsObject, IRetsObjectOptions
} from './models';
import { combineQueryOptions, combineObjectOptions } from './tools/combine';
import { parseMultipartResponse } from './parsers/parseMultipartResponse';
import { parseObjectResponse } from './parsers/parseObjectResponse';
import { parseRetsResponse } from './parsers/parseRetsResponse';
import { processHeaders } from './tools/processHeaders';
import { replaceAddress } from './tools/replaceAddress';
import { isIncluded } from './tools/isIncluded';

/**
 * Client for communicate with RETS server
 */
export class RetsClient {
    /**
     * Client configuration
     */
    public readonly configuration: IClientConnection;
    /**
     * Available rets actions
     */
    public readonly actions: { [key: string]: DefaultUriUrlRequestApi<Request, CoreOptions, OptionalUriUrl> } = {};
    private session: RequestAPI<Request, CoreOptions, RequiredUriUrl>;
    private headers: { [key: string]: any } = {};

    /**
     * Create a new RETS client
     * @param configuration Client configuration
     */
    public constructor(configuration: IClientConnection) {
        this.configuration = cloneDeep(configuration);
        this.createHeader();
        this.session = defaultRequest({
            jar: requestJar(),
            headers: this.headers,
            method: this.configuration.method || 'GET',
            auth: {
                user: this.configuration.username,
                pass: this.configuration.password,
                sendImmediately: false
            },
            timeout: this.configuration.timeout,
            proxy: this.configuration.proxyUrl,
            tunnel: this.configuration.useTunnel
        });
        this.actions[RetsAction.Login] = this.session.defaults({ uri: this.configuration.url });
    }

    /**
     * Send Login request
     */
    public async login(): Promise<void> {
        const response = await this.sendAction(this.findRequest(RetsAction.Login)).catch((e: Error | IRetsResponse) => e);
        if (response instanceof Error) { throw response; }
        if (response.headers.SetCookie) {
            const cookies = ([] as string[]).concat(response.headers.SetCookie);
            for (let i = -1; ++i < cookies.length;) {
                const matches = cookies[i].match(/(?:(?:RETS-Session-ID)|(?:X-SESSIONID))=([^;]+);/);
                if (matches) {
                    this.configuration.sessionId = matches[1];
                    break;
                }
            }
        }
        if (response.headers.RETSVersion) {
            this.configuration.version =
                (response.headers.RETSVersion instanceof Array ? response.headers.RETSVersion[0] : response.headers.RETSVersion) as RetsVersion;
        }
        this.createHeader(); // 更新Header
        const source = (response.body as IRetsBody).extra.content;
        if (!source) {
            throw new RetsProcessingError(new ReferenceError('Could not find URL information after login'));
        }
        source.split('\r\n').filter(v => v.indexOf('=') > -1).map(v => v.replace(/\s/g, '').split('=')).forEach(url => {
            const [name, address] = url;
            let action: RetsAction | undefined;
            switch (name) {
                case 'GetObject':
                    action = RetsAction.GetObject;
                    break;
                case 'Logout':
                    action = RetsAction.Logout;
                    break;
                case 'Search':
                    action = RetsAction.Search;
                    break;
            }
            if (action != null) {
                this.actions[action] = this.session.defaults({ uri: replaceAddress(address, this.configuration.url) });
            }
        });
    }

    /**
     * Send Logout request
     */
    public async logout(): Promise<void> {
        const response = await this.sendAction(this.findRequest(RetsAction.Logout)).catch((e: Error | IRetsResponse) => e);
        if (response instanceof Error) { throw response; }
        delete this.actions[RetsAction.GetObject];
        delete this.actions[RetsAction.Logout];
        delete this.actions[RetsAction.Search];
    }

    /**
     * Send Search request
     * @param options Search options
     */
    public async search(options: IRetsQueryOptions): Promise<IRetsBody> {
        const response = await this.sendAction(this.findRequest(RetsAction.Search), combineQueryOptions(options));
        if (response instanceof Error) { throw response; }
        return response.body as IRetsBody;
    }

    /**
     * Send GetObject request
     * @param options GetObject options
     */
    public async getObjects(options: IRetsObjectOptions, timeout = 2147483640): Promise<IRetsObject | IRetsObject[]> {
        const action = this.findRequest(RetsAction.GetObject).defaults({
            headers: {
                ...this.headers,
                Accept: options.mime || 'image/jpeg'
            },
            encoding: null
        });
        const response = await this.sendAction(action, combineObjectOptions(options), timeout);
        if (response instanceof Error) { throw response; }
        return (response.body instanceof Array ? response.body : [response.body]) as IRetsObject[];
    }

    private createHeader(): void {
        this.headers = this.headers || {};
        this.headers['User-Agent'] = this.configuration.userAgent || 'RETS NodeJS-Client/1.x';
        this.headers['RETS-Version'] = this.configuration.version;
        if (this.configuration.userAgentPassword) {
            this.headers['RETS-UA-Authorization'] = 'Digest ' + createHash('md5').update([
                createHash('md5').update(`${this.configuration.userAgent}:${this.configuration.userAgentPassword}`).digest('hex'),
                '',
                this.configuration.sessionId || '',
                this.headers['RETS-Version']
            ].join(':')).digest('hex');
        }
    }

    private findRequest(action: RetsAction): DefaultUriUrlRequestApi<Request, CoreOptions, OptionalUriUrl> {
        if (!this.actions[action]) { throw new RetsClientError('No active session detected. Need login first.'); }
        return this.actions[action];
    }

    /**
     *
     * @param action
     * @param query optional
     * @param timeout optional request timeout, whem timeout returns a error
     */
    private async sendAction(action: DefaultUriUrlRequestApi<Request, CoreOptions, OptionalUriUrl>, query?: any, timeout = 2147483640): Promise<IRetsResponse> {
        const data = await new Promise<{ response: Response, body: any }>((resolve, reject) =>
            action(
                { [this.configuration.method === RetsRequestMethod.POST ? 'form' : 'qs']: query, timeout: timeout},
                (e, r, b) => {
                    if (e) {
                        reject(e);
                    } else {
                        resolve({ response: r, body: b });
                    }
                })
        ).catch((e: Error) => e);
        if (data instanceof Error) { throw data; }
        if (data.response.statusCode !== 200) {
            throw new RetsServerError(data.response.statusCode, data.response.statusMessage);
        } else {
            const headers = processHeaders(data.response.rawHeaders);
            let body: Promise<IRetsBody | IRetsObject | IRetsObject[]>;
            if (isIncluded(v => v.includes('text/xml'), headers.ContentType)) {
                body = parseRetsResponse(data.body);
            } else if (isIncluded(v => v.includes('multipart'), headers.ContentType)) {
                body = parseMultipartResponse(data.body, headers);
            } else {
                body = parseObjectResponse(data.body, headers);
            }
            const response = {
                headers: headers,
                body: await body.catch((e: Error) => e),
                response: data.response
            };
            if (response.body instanceof Error) { throw response.body; }
            return response as IRetsResponse;
        }
    }
}
