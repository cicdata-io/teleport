/*
Copyright 2020 Gravitational, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { useCallback, useEffect, useRef } from 'react';
import { useAsync } from 'shared/hooks/useAsync';
import { runOnce } from 'shared/utils/highbar';

import { useAppContext } from 'teleterm/ui/appContextProvider';
import { IAppContext } from 'teleterm/ui/types';
import {
  DocumentsService,
  isDocumentTshNodeWithLoginHost,
} from 'teleterm/ui/services/workspacesService';
import { IPtyProcess } from 'teleterm/sharedProcess/ptyHost';
import { useWorkspaceContext } from 'teleterm/ui/Documents';
import { routing } from 'teleterm/ui/uri';
import { PtyCommand, PtyProcessCreationStatus } from 'teleterm/services/pty';
import { AmbiguousHostnameError } from 'teleterm/ui/services/resources';
import { retryWithRelogin } from 'teleterm/ui/utils';
import Logger from 'teleterm/logger';

import type * as types from 'teleterm/ui/services/workspacesService';
import type * as uri from 'teleterm/ui/uri';
import type * as tsh from 'teleterm/services/tshd/types';

export function useDocumentTerminal(doc: types.DocumentTerminal) {
  const logger = useRef(new Logger('useDocumentTerminal'));
  const ctx = useAppContext();
  const { documentsService } = useWorkspaceContext();
  const [attempt, startTerminal] = useAsync(async () => {
    try {
      return await startTerminalSession(
        ctx,
        logger.current,
        documentsService,
        doc
      );
    } catch (err) {
      if ('status' in doc) {
        documentsService.update(doc.uri, { status: 'error' });
      }

      throw err;
    }
  });

  useEffect(() => {
    if (attempt.status === '') {
      startTerminal();
    }

    return () => {
      if (attempt.status === 'success') {
        attempt.data.ptyProcess.dispose();
      }
    };
  }, [attempt]);

  const reconnect = useCallback(() => {
    if ('status' in doc) {
      documentsService.update(doc.uri, { status: 'connecting' });
    }
    startTerminal();
  }, [documentsService, doc.uri, startTerminal]);

  return { attempt, reconnect };
}

async function startTerminalSession(
  ctx: IAppContext,
  logger: Logger,
  documentsService: DocumentsService,
  doc: types.DocumentTerminal
) {
  if (isDocumentTshNodeWithLoginHost(doc)) {
    doc = await resolveLoginHost(ctx, logger, documentsService, doc);
  }

  return setUpPtyProcess(ctx, documentsService, doc);
}

/**
 * resolveLoginHost tries to split loginHost from the doc into a login and a host and then resolve
 * the host to a server UUID by asking the cluster for an SSH server with a matching hostname.
 *
 * It also updates the doc in DocumentsService. It's important for this function to return the
 * updated doc so that setUpPtyProcess can use the resolved server UUID – startTerminalSession is
 * called only once, it won't be re-run after the doc gets updated.
 */
async function resolveLoginHost(
  ctx: IAppContext,
  logger: Logger,
  documentsService: DocumentsService,
  doc: types.DocumentTshNodeWithLoginHost
): Promise<types.DocumentTshNodeWithServerId> {
  let login: string | undefined, host: string;
  const parts = doc.loginHost.split('@');
  const clusterUri = routing.getClusterUri({
    rootClusterId: doc.rootClusterId,
    leafClusterId: doc.leafClusterId,
  });

  if (parts.length > 1) {
    host = parts.pop();
    // If someone enters `foo@bar@baz` as an input here, `parts` will have more than two elements.
    // `foo@bar` is probably not a valid login, but we don't want to lose that input here.
    //
    // In any case, we're just repeating what `tsh ssh` is doing with inputs like these - it treats
    // the last part as the host and all the text before it as the login.
    login = parts.join('@');
  } else {
    // If someone enters just `host` as an input, we still want to execute `tsh ssh host`. It might
    // be that the username of the current OS user matches one of the usernames available on the
    // host in which case providing the username directly is not necessary.
    host = parts[0];
  }

  let server: tsh.Server | undefined;
  let serverUri: uri.ServerUri, serverHostname: string;

  try {
    // TODO(ravicious): Handle finding a server by more than just a name.
    // Basically we have to replicate tsh ssh behavior here.
    server = await retryWithRelogin(ctx, clusterUri, () =>
      ctx.resourcesService.getServerByHostname(clusterUri, host)
    );
  } catch (error) {
    // TODO(ravicious): Handle ambiguous host name. See `onSSH` in `tool/tsh/tsh.go`.
    if (error instanceof AmbiguousHostnameError) {
      // Log the ambiguity of the hostname but continue anyway. This will pass the ambiguous
      // hostname to tsh ssh and show an appropriate error in the new tab.
      logger.error(error.message);
    } else {
      throw error;
    }
  }

  if (server) {
    serverUri = server.uri;
    serverHostname = server.hostname;
  } else {
    // If we can't find a server by the given hostname, we still want to create a document to
    // handle the error further down the line. It also lets the user connect to a host by its UUID.
    serverUri = routing.getServerUri({
      rootClusterId: doc.rootClusterId,
      leafClusterId: doc.leafClusterId,
      serverId: host,
    });
    serverHostname = host;
  }

  const title = login ? `${login}@${serverHostname}` : serverHostname;

  const docFieldsToUpdate = {
    loginHost: undefined,
    serverId: routing.parseServerUri(serverUri).params.serverId,
    serverUri,
    login,
    title,
  };

  // Returning the updated doc as described in the JSDoc for this function.
  const updatedDoc = {
    ...doc,
    ...docFieldsToUpdate,
  };

  documentsService.update(doc.uri, docFieldsToUpdate);
  return updatedDoc;
}

async function setUpPtyProcess(
  ctx: IAppContext,
  documentsService: DocumentsService,
  doc: types.DocumentTerminal
) {
  const getClusterName = () => {
    const cluster = ctx.clustersService.findCluster(clusterUri);
    if (cluster) {
      return cluster.name;
    }

    /*
     When restoring the documents, we do not always have the leaf clusters already fetched.
     In that case we can fall back to `clusterId` from a leaf cluster URI
     (for a leaf cluster `clusterId` === `name`)
    */
    const parsed = routing.parseClusterUri(clusterUri);

    if (!parsed?.params?.leafClusterId) {
      throw new Error(
        'The leaf cluster URI was expected, but the URI does not contain the leaf cluster ID'
      );
    }
    return parsed.params.leafClusterId;
  };

  const clusterUri = routing.getClusterUri({
    rootClusterId: doc.rootClusterId,
    leafClusterId: doc.leafClusterId,
  });
  const rootCluster = ctx.clustersService.findRootClusterByResource(clusterUri);
  const cmd = createCmd(doc, rootCluster.proxyHost, getClusterName());
  const ptyProcess = await createPtyProcess(ctx, cmd);

  if (cmd.kind === 'pty.tsh-login') {
    ctx.usageService.captureProtocolUse(clusterUri, 'ssh');
  }
  if (cmd.kind === 'pty.tsh-kube-login') {
    ctx.usageService.captureProtocolUse(clusterUri, 'kube');
  }

  const openContextMenu = () => ctx.mainProcessClient.openTerminalContextMenu();

  const refreshTitle = async () => {
    if (cmd.kind !== 'pty.shell') {
      return;
    }

    const cwd = await ptyProcess.getCwd();
    documentsService.update(doc.uri, {
      cwd,
      title: `${cwd || 'Terminal'} · ${getClusterName()}`,
    });
  };

  const removeInitCommand = () => {
    if (doc.kind !== 'doc.terminal_shell') {
      return;
    }
    // The initCommand has to be launched only once, not every time we recreate the document from
    // the state.
    //
    // Imagine that someone creates a new terminal document with `rm -rf /tmp` as initCommand.
    // We'd execute the command each time the document gets recreated from the state, which is not
    // what the user would expect.
    documentsService.update(doc.uri, { initCommand: undefined });
  };

  ptyProcess.onOpen(() => {
    refreshTitle();
    removeInitCommand();
  });

  // TODO(ravicious): Refactor runOnce to not use the `n` variable. Otherwise runOnce subtracts 1
  // from n each time the resulting function is executed, which in this context means each time data
  // is transferred from PTY.
  const markDocumentAsConnectedOnce = runOnce(() => {
    if ('status' in doc) {
      documentsService.update(doc.uri, { status: 'connected' });
    }
  });

  // mark document as connected when first data arrives
  ptyProcess.onData(() => markDocumentAsConnectedOnce());

  ptyProcess.onExit(event => {
    // Not closing the tab on non-zero exit code lets us show the error to the user if, for example,
    // tsh ssh cannot connect to the given node.
    //
    // The downside of this is that if you open a local shell, then execute a command that fails
    // (for example, `cd` to a nonexistent directory), and then try to execute `exit` or press
    // Ctrl + D, the tab won't automatically close, because the last exit code is not zero.
    //
    // We can look up how the terminal in vscode handles this problem, since in the scenario
    // described above they do close the tab correctly.
    if (event.exitCode === 0) {
      documentsService.close(doc.uri);
    }
  });

  return {
    ptyProcess,
    refreshTitle,
    openContextMenu,
  };
}

async function createPtyProcess(
  ctx: IAppContext,
  cmd: PtyCommand
): Promise<IPtyProcess> {
  const { process, creationStatus } =
    await ctx.terminalsService.createPtyProcess(cmd);

  if (creationStatus === PtyProcessCreationStatus.ResolveShellEnvTimeout) {
    ctx.notificationsService.notifyWarning({
      title: 'Could not source environment variables for shell session',
      description:
        "In order to source the environment variables, a new temporary shell session is opened and then immediately closed, but it didn't close within 10 seconds. " +
        'This most likely means that your shell startup took longer to execute or that your shell waits for an input during startup. \nPlease check your startup files.',
    });
  }

  return process;
}

function createCmd(
  doc: types.DocumentTerminal,
  proxyHost: string,
  clusterName: string
): PtyCommand {
  if (doc.kind === 'doc.terminal_tsh_node') {
    if (isDocumentTshNodeWithLoginHost(doc)) {
      throw new Error(
        'Cannot create a PTY for doc.terminal_tsh_node without serverId'
      );
    }

    return {
      kind: 'pty.tsh-login',
      proxyHost,
      clusterName,
      login: doc.login,
      serverId: doc.serverId,
      rootClusterId: doc.rootClusterId,
      leafClusterId: doc.leafClusterId,
    };
  }

  if (doc.kind === 'doc.terminal_tsh_kube') {
    return {
      ...doc,
      proxyHost,
      clusterName,
      kind: 'pty.tsh-kube-login',
    };
  }

  return {
    ...doc,
    kind: 'pty.shell',
    proxyHost,
    clusterName,
    cwd: doc.cwd,
    initCommand: doc.initCommand,
  };
}

export type Props = {
  doc: types.DocumentTerminal;
  visible: boolean;
};
