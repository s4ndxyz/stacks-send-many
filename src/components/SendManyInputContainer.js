import React, { useRef, useState, useEffect } from 'react';
import {
  listCV,
  tupleCV,
  standardPrincipalCV,
  contractPrincipalCV,
  uintCV,
  PostConditionMode,
  makeStandardSTXPostCondition,
  FungibleConditionCode,
  bufferCVFromString,
  cvToString,
  makeStandardFungiblePostCondition,
  createAssetInfo,
  trueCV,
  noneCV,
} from '@stacks/transactions';

import {
  CONTRACT_ADDRESS,
  mainnet,
  namesApi,
  NETWORK,
  WRAPPED_BITCOIN_ASSET,
  WRAPPED_BITCOIN_CONTRACT,
  XBTC_SEND_MANY_CONTRACT,
} from '../lib/constants';
import { fetchAccount } from '../lib/account';
import { chains, userSessionState } from '../lib/auth';
import { useAtomValue } from 'jotai/utils';
import { useConnect } from '@stacks/connect-react';
import { saveTxData, TxStatus } from '../lib/transactions';
import { c32addressDecode } from 'c32check';
import { SendManyInput } from './SendManyInput';
import { Address } from './Address';
import { Amount } from './Amount';
import toAscii from 'punycode2/to-ascii';

const addrToCV = addr => {
  const toParts = addr.split('.');
  if (toParts.length === 1) {
    return standardPrincipalCV(toParts[0]);
  } else {
    return contractPrincipalCV(toParts[0], toParts[1]);
  }
};

const addToCVValues = async parts => {
  return Promise.all(
    parts.map(async p => {
      if (p.to === '') {
        return p;
      }
      try {
        return { ...p, toCV: addrToCV(p.to) };
      } catch (e) {
        try {
          const nameInfo = await namesApi.getNameInfo({ name: toAscii(p.to) });
          if (nameInfo.address) {
            return { ...p, toCV: addrToCV(nameInfo.address) };
          } else {
            return { ...p, error: `No address for ${p.to}` };
          }
        } catch (e2) {
          return { ...p, error: `${p.to} not found` };
        }
      }
    })
  );
};

function nonEmptyPart(p) {
  return !!p.toCV && p.stx !== '0' && p.stx !== '';
}

export function SendManyInputContainer({ asset, ownerStxAddress, client, wcSession }) {
  const userSession = useAtomValue(userSessionState);
  const spinner = useRef();
  const [status, setStatus] = useState();
  const [account, setAccount] = useState();
  const [txId, setTxId] = useState();
  const [preview, setPreview] = useState();
  const [loading, setLoading] = useState(false);
  const [namesResolved, setNamesResolved] = useState(true);
  const [firstMemoForAll, setFirstMemoForAll] = useState(false);

  const [rows, setRows] = useState([{ to: '', stx: '0', memo: '' }]);
  const { doContractCall } = useConnect();

  useEffect(() => {
    if (ownerStxAddress) {
      fetchAccount(ownerStxAddress)
        .catch(e => {
          setStatus('Failed to access your account', e);
          console.log(e);
        })
        .then(async acc => {
          setAccount(acc);
          console.log({ acc });
        });
    }
  }, [ownerStxAddress]);

  const updatePreview = async ({ parts, total, hasMemos }) => {
    setPreview(
      <>
        {parts.map(p => {
          try {
            c32addressDecode(p.to);
            return (
              <>
                <Address addr={p.to} />:{' '}
                {asset === 'stx' ? <Amount ustx={p.ustx} /> : <Amount xbtc={p.ustx} />} <br />
              </>
            );
          } catch (e) {
            setNamesResolved(p.toCV);
            return (
              <>
                {p.error || (p.toCV ? <Address addr={cvToString(p.toCV)} /> : '...')}:{' '}
                {asset === 'stx' ? <Amount ustx={p.ustx} /> : <Amount xsats={p.ustx} />} <br />
                <br />
              </>
            );
          }
        })}{' '}
        Total: {asset === 'stx' ? <Amount ustx={total} /> : <Amount xsats={total} />} <br />
        <br />
        {hasMemos && (
          <>
            Sending with memos.
            <br />
          </>
        )}
        {asset === 'stx' &&
          total + 1000 > parseInt(account.stx.balance) - parseInt(account.stx.locked) && (
            <small>
              That is more than you have. You have <Amount ustx={account.stx.balance} />
            </small>
          )}
        {asset === 'xbtc' &&
          total > (account.fungible_tokens?.[WRAPPED_BITCOIN_ASSET]?.balance || 0) && (
            <small>
              That is more than you have. You have{' '}
              <Amount xsats={account.fungible_tokens?.[WRAPPED_BITCOIN_ASSET]?.balance || 0} />
            </small>
          )}
      </>
    );
  };

  const getPartsFromRows = currentRows => {
    const parts = currentRows.map(r => {
      return {
        ...r,
        ustx: Math.floor(parseFloat(r.stx) * (asset === 'stx' ? 1_000_000 : 100_000_000)),
      };
    });
    const { total, hasMemos } = parts.reduce(
      (previous, r) => {
        return {
          total: isNaN(r.ustx) ? previous.total : (previous.total += r.ustx),
          hasMemos: previous.hasMemos || r.memo,
        };
      },
      {
        total: 0,
        hasMemos: false,
      }
    );
    return { parts, total, hasMemos };
  };

  const sendAsset = async options => {
    options = {
      ...options,
      network: NETWORK,
      postConditionMode: PostConditionMode.Deny,
      onFinish: data => {
        setStatus('Saving transaction to your storage');
        setTxId(data.txId);
        if (userSession) {
          saveTxData(data, userSession)
            .then(r => {
              setRows([{ to: '', stx: '0', memo: '' }]);
              setPreview(null);
              setLoading(false);
              setStatus(undefined);
            })
            .catch(e => {
              console.log(e);
              setLoading(false);
              setStatus("Couldn't save the transaction");
            });
        }
      },
      onCancel: () => {
        setStatus('Transaction not sent.');
        setLoading(false);
      },
    };
    try {
      setStatus(`Sending transaction`);
      if (wcSession) {
        console.log('start client request', ownerStxAddress, options);
        try {
          const result = await client.request({
            chainId: chains[mainnet ? 0 : 1],
            topic: wcSession.topic,
            request: {
              method: 'stacks_contractCall',
              params: {
                pubkey: ownerStxAddress,
                contractAddress: options.contractAddress,
                contractName: options.contractName,
                functionName: options.functionName,
                functionArgs: options.functionArgs,
                postConditions: options.postConditions,
                postConditionMode: PostConditionMode.Deny,
                version: '1',
              },
            },
          });
          console.log({ result });
        } catch (e) {
          console.log(e);
        }
      } else {
        await doContractCall(options);
      }
    } catch (e) {
      console.log(e);
      setStatus(e.toString());
      setLoading(true);
    }
  };

  const sendAction = async () => {
    setLoading(true);
    setStatus();
    const { parts, total, hasMemos } = getPartsFromRows(rows);
    const updatedParts = await addToCVValues(parts);
    let invalidNames = updatedParts.filter(r => !!r.error);
    if (invalidNames.length > 0) {
      updatePreview({ parts: updatedParts, total, hasMemos });
      setLoading(false);
      setStatus('Please verify receivers');
      return;
    }
    if (!namesResolved) {
      updatePreview({ parts: updatedParts, total, hasMemos });
      setLoading(false);
      setNamesResolved(true);
      return;
    }
    const nonEmptyParts = updatedParts.filter(nonEmptyPart);
    console.log(nonEmptyParts[0]);
    const firstMemo =
      nonEmptyParts.length > 0 && nonEmptyParts[0].memo ? nonEmptyParts[0].memo.trim() : '';
    let options;
    if (asset === 'stx') {
      options = {
        contractAddress: CONTRACT_ADDRESS,
        contractName: hasMemos ? 'send-many-memo' : 'send-many',
        functionName: 'send-many',
        functionArgs: [
          listCV(
            nonEmptyParts.map(p => {
              return hasMemos
                ? tupleCV({
                    to: p.toCV,
                    ustx: uintCV(p.ustx),
                    memo: bufferCVFromString(
                      firstMemoForAll ? firstMemo : p.memo ? p.memo.trim() : ''
                    ),
                  })
                : tupleCV({ to: p.toCV, ustx: uintCV(p.ustx) });
            })
          ),
        ],
        postConditions: [
          makeStandardSTXPostCondition(ownerStxAddress, FungibleConditionCode.Equal, total),
        ],
      };
    } else {
      options = {
        contractAddress: XBTC_SEND_MANY_CONTRACT.address,
        contractName: XBTC_SEND_MANY_CONTRACT.name,
        functionName: 'send-xbtc',
        functionArgs: [
          nonEmptyParts.map(p => {
            return tupleCV({
              to: p.toCV,
              'xbtc-in-sats': uintCV(p.ustx),
              memo: bufferCVFromString(
                hasMemos ? (firstMemoForAll ? firstMemo : p.memo ? p.memo.trim() : '') : ''
              ),
              'swap-to-ustx': trueCV(),
              'min-dy': noneCV(),
            });
          })[0],
        ],
        postConditions: [
          makeStandardFungiblePostCondition(
            ownerStxAddress,
            FungibleConditionCode.Equal,
            total,
            createAssetInfo(
              WRAPPED_BITCOIN_CONTRACT.address,
              WRAPPED_BITCOIN_CONTRACT.name,
              WRAPPED_BITCOIN_CONTRACT.asset
            )
          ),
        ],
      };
    }
    sendAsset(options);
  };

  const addNewRow = () => {
    const newRows = [...rows];
    newRows.push({ to: '', stx: '0', memo: '' });
    setRows(newRows);
  };

  const updateRow = (row, index) => {
    const newRows = [...rows];
    newRows[index] = row;
    setRows(newRows);
    return newRows;
  };

  const updateModel = index => {
    return row => {
      const rows = updateRow(row, index);
      updatePreview(getPartsFromRows(rows));
    };
  };

  const maybeAddNewRow = index => {
    return () => {
      if (index === rows.length - 1) {
        addNewRow();
      }
    };
  };

  const handleOnPaste = e => {
    e.preventDefault();
    const entries = e.clipboardData
      .getData('Text')
      .split('\n')
      .map(entry => entry.split(','))
      .map(entryParts => {
        return {
          to: entryParts[0].trim().replace(/-([^-]*)$/, '.$1'),
          stx: entryParts[1].trim(),
          memo: entryParts.length > 2 ? entryParts[2].trim() : undefined,
        };
      });
    const newRows = [...entries];
    setRows(newRows);
  };

  return (
    <div>
      <div className="NoteField">
        {rows.map((row, index) => {
          return (
            <SendManyInput
              key={index}
              row={row}
              index={index}
              updateModel={updateModel(index)}
              maybeAddNewRow={maybeAddNewRow(index)}
              lastRow={index === rows.length - 1}
            />
          );
        })}
        <div className="row">
          <div className="col-md-12 col-xs-12 col-lg-12 text-right pb-2">
            <input
              onClick={e => addNewRow()}
              disabled={rows.length > 199}
              type="button"
              value="Add New Recipient"
              className="btn btn-dark"
              id="addNewField"
            />
          </div>
        </div>
        <div className="row">
          <div className="col-md-12 col-xs-12 col-lg-12 text-right pb-2">
            <input
              onPaste={handleOnPaste}
              type="text"
              placeholder="Paste entry list"
              className="form-control"
            />
          </div>
        </div>
        <div className="row">
          <div className="col-md-12 col-xs-12 col-lg-12 text-right pb-2">
            <input
              className="form-check-input"
              type="checkbox"
              onChange={e => setFirstMemoForAll(e.target.checked)}
              id="firstMemoForAll"
              value={firstMemoForAll}
            />
            <label className="form-check-label" forhtml="firstMemoForAll">
              First Memo for all?
            </label>
          </div>
        </div>

        <div>{preview}</div>
        <div className="input-group mt-2">
          <button className="btn btn-block btn-primary" type="button" onClick={sendAction}>
            <div
              ref={spinner}
              role="status"
              className={`${
                loading ? '' : 'd-none'
              } spinner-border spinner-border-sm text-info align-text-top mr-2`}
            />
            {namesResolved ? 'Send' : 'Preview'}
          </button>
        </div>
      </div>
      <div>
        <TxStatus txId={txId} resultPrefix="Transfers executed? " />
      </div>
      {status && (
        <>
          <div>
            <small>{status}</small>
          </div>
        </>
      )}
    </div>
  );
}
