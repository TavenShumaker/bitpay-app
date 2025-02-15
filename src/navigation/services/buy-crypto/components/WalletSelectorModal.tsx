import React from 'react';
import GlobalSelect from '../../../../navigation/wallet/screens/GlobalSelect';
import {Black, White} from '../../../../styles/colors';
import styled from 'styled-components/native';
import SheetModal from '../../../../components/modal/base/sheet/SheetModal';
import {includes, sortBy} from 'lodash';
import {SUPPORTED_CURRENCIES} from '../../../../constants/currencies';

const GlobalSelectContainer = styled.View`
  flex: 1;
  background-color: ${({theme: {dark}}) => (dark ? Black : White)};
`;

interface WalletSelectorModalProps {
  isVisible: boolean;
  customSupportedCurrencies?: string[];
  livenetOnly?: boolean;
  onDismiss: (newWallet?: any) => void;
  modalTitle?: string;
}

const WalletSelectorModal: React.FC<WalletSelectorModalProps> = ({
  isVisible,
  customSupportedCurrencies,
  livenetOnly,
  onDismiss,
  modalTitle,
}) => {
  const sortedCustomSupportedCurrencies = sortBy(
    customSupportedCurrencies,
    coin => (includes(SUPPORTED_CURRENCIES, coin) ? -1 : 1),
  );
  return (
    <SheetModal isVisible={isVisible} onBackdropPress={onDismiss}>
      <GlobalSelectContainer>
        <GlobalSelect
          useAsModal={true}
          modalTitle={modalTitle}
          customSupportedCurrencies={sortedCustomSupportedCurrencies}
          onDismiss={onDismiss}
          livenetOnly={livenetOnly}
        />
      </GlobalSelectContainer>
    </SheetModal>
  );
};

export default WalletSelectorModal;
