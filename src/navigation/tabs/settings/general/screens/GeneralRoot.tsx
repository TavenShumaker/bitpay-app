import React from 'react';
import {
  Hr,
  Setting,
  Settings,
  SettingsContainer,
  SettingTitle,
} from '../../SettingsRoot';
import AngleRight from '../../../../../../assets/img/angle-right.svg';
import Button from '../../../../../components/button/Button';
import {useNavigation} from '@react-navigation/native';
import {useSelector} from 'react-redux';
import {RootState} from '../../../../../store';

const GeneralSettingsRoot: React.FC = () => {
  const navigation = useNavigation();
  const colorScheme = useSelector(({APP}: RootState) => APP.colorScheme);

  return (
    <SettingsContainer>
      <Settings>
        <Hr />
        <Setting
          onPress={() =>
            navigation.navigate('GeneralSettings', {screen: 'Theme'})
          }>
          <SettingTitle>Theme</SettingTitle>
          <Button
            buttonType={'pill'}
            onPress={() =>
              navigation.navigate('GeneralSettings', {screen: 'Theme'})
            }>
            {colorScheme === 'light' ? 'Light Mode' : 'Dark Mode'}
          </Button>
        </Setting>
        <Hr />
      </Settings>
    </SettingsContainer>
  );
};

export default GeneralSettingsRoot;
