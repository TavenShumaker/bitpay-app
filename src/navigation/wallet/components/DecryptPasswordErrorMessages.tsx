import React from 'react';
import {BottomNotificationConfig} from '../../../components/modal/bottom-notification/BottomNotification';
import styled from 'styled-components/native';
import {BaseText} from '../../../components/styled/Text';
import {FlatList} from 'react-native';

interface BottomNotificationListType {
  key: number;
  description: string;
}

const List = styled(BaseText)`
  margin: 0 0 5px 10px;
`;

export const GeneralError: BottomNotificationConfig = {
  type: 'error',
  title: 'Something went wrong',
  message: 'Could not decrypt wallet.',
  enableBackdropDismiss: true,
  actions: [
    {
      text: 'OK',
      action: () => {},
      primary: true,
    },
  ],
};

export const WrongPasswordError = (): BottomNotificationConfig => {
  const wrongPasswordList: BottomNotificationListType[] = [
    {
      key: 1,
      description: 'Try entering any passwords you may have set in the past',
    },
    {
      key: 2,
      description:
        'Remember there are no special requirements for the password (numbers, symbols, etc.)',
    },
    {
      key: 3,
      description:
        'Keep in mind your encryption password is not the 12-word recovery phrase',
    },
    {
      key: 4,
      description:
        'You can always reset your encryption password on your key settings under the option Clear Encryption Password using your 12-word recovery phrase',
    },
  ];

  return {
    type: 'error',
    title: 'Wrong password',
    message: 'Forgot Password?',
    enableBackdropDismiss: true,
    actions: [
      {
        text: 'GOT IT',
        action: () => {},
        primary: true,
      },
    ],
    message2: (
      <FlatList
        data={wrongPasswordList}
        renderItem={({item}) => (
          <List>
            {'\u2022'} {item.description}
          </List>
        )}
      />
    ),
  };
};
